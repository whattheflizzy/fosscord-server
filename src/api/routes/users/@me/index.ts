import { Router, Request, Response } from "express";
import {
	User,
	PrivateUserProjection,
	emitEvent,
	UserUpdateEvent,
	handleFile,
	FieldErrors,
	adjustEmail,
	Config,
	UserModifySchema,
	generateToken,
} from "@fosscord/util";
import { route } from "@fosscord/api";
import bcrypt from "bcrypt";

const router: Router = Router();

router.get("/", route({}), async (req: Request, res: Response) => {
	res.json(
		await User.findOne({
			select: PrivateUserProjection,
			where: { id: req.user_id },
		}),
	);
});

router.patch(
	"/",
	route({ body: "UserModifySchema" }),
	async (req: Request, res: Response) => {
		const body = req.body as UserModifySchema;

		const user = await User.findOneOrFail({
			where: { id: req.user_id },
			select: [...PrivateUserProjection, "data"],
		});

		// Populated on password change
		var newToken: string | undefined;

		if (body.avatar)
			body.avatar = await handleFile(
				`/avatars/${req.user_id}`,
				body.avatar as string,
			);
		if (body.banner)
			body.banner = await handleFile(
				`/banners/${req.user_id}`,
				body.banner as string,
			);

		if (body.password) {
			if (user.data?.hash) {
				const same_password = await bcrypt.compare(
					body.password,
					user.data.hash || "",
				);
				if (!same_password) {
					throw FieldErrors({
						password: {
							message: req.t("auth:login.INVALID_PASSWORD"),
							code: "INVALID_PASSWORD",
						},
					});
				}
			} else {
				user.data.hash = await bcrypt.hash(body.password, 12);
			}
		}

		if (body.email) {
			body.email = adjustEmail(body.email);
			if (!body.email && Config.get().register.email.required)
				throw FieldErrors({
					email: {
						message: req.t("auth:register.EMAIL_INVALID"),
						code: "EMAIL_INVALID",
					},
				});
			if (!body.password)
				throw FieldErrors({
					password: {
						message: req.t("auth:register.INVALID_PASSWORD"),
						code: "INVALID_PASSWORD",
					},
				});
		}

		if (body.new_password) {
			if (!body.password && !user.email) {
				throw FieldErrors({
					password: {
						code: "BASE_TYPE_REQUIRED",
						message: req.t("common:field.BASE_TYPE_REQUIRED"),
					},
				});
			}
			user.data.hash = await bcrypt.hash(body.new_password, 12);
			user.data.valid_tokens_since = new Date();
			newToken = (await generateToken(user.id)) as string;
		}

		if (body.username) {
			var check_username = body?.username?.replace(/\s/g, "");
			if (!check_username) {
				throw FieldErrors({
					username: {
						code: "BASE_TYPE_REQUIRED",
						message: req.t("common:field.BASE_TYPE_REQUIRED"),
					},
				});
			}
		}

		if (body.discriminator) {
			if (
				await User.findOne({
					where: {
						discriminator: body.discriminator,
						username: body.username || user.username,
					},
				})
			) {
				throw FieldErrors({
					discriminator: {
						code: "INVALID_DISCRIMINATOR",
						message: "This discriminator is already in use.",
					},
				});
			}
		}

		user.assign(body);
		user.validate();
		await user.save();

		// @ts-ignore
		delete user.data;

		// TODO: send update member list event in gateway
		await emitEvent({
			event: "USER_UPDATE",
			user_id: req.user_id,
			data: user,
		} as UserUpdateEvent);

		res.json({
			...user,
			newToken,
		});
	},
);

export default router;
// {"message": "Invalid two-factor code", "code": 60008}
