import {
	BeforeInsert,
	BeforeUpdate,
	Column,
	Entity,
	FindOneOptions,
	JoinColumn,
	OneToMany,
	OneToOne,
} from "typeorm";
import { BaseClass } from "./BaseClass";
import { BitField } from "../util/BitField";
import { Relationship } from "./Relationship";
import { ConnectedAccount } from "./ConnectedAccount";
import { Member } from "./Member";
import { UserSettings } from "./UserSettings";
import { Session } from "./Session";
import { Config, FieldErrors, Snowflake, trimSpecial, adjustEmail } from "..";

export enum PublicUserEnum {
	username,
	discriminator,
	id,
	public_flags,
	avatar,
	accent_color,
	banner,
	bio,
	bot,
	premium_since,
	premium_type,
	theme_colors,
	pronouns,
}
export type PublicUserKeys = keyof typeof PublicUserEnum;

export enum PrivateUserEnum {
	flags,
	mfa_enabled,
	email,
	phone,
	verified,
	nsfw_allowed,
	premium,
	premium_type,
	purchased_flags,
	premium_usage_flags,
	disabled,
	// settings,	// now a relation
	// locale
}
export type PrivateUserKeys = keyof typeof PrivateUserEnum | PublicUserKeys;

export const PublicUserProjection = Object.values(PublicUserEnum).filter(
	(x) => typeof x === "string",
) as PublicUserKeys[];
export const PrivateUserProjection = [
	...PublicUserProjection,
	...Object.values(PrivateUserEnum).filter((x) => typeof x === "string"),
] as PrivateUserKeys[];

// Private user data that should never get sent to the client
export type PublicUser = Pick<User, PublicUserKeys>;

export interface UserPublic extends Pick<User, PublicUserKeys> {}

export interface UserPrivate extends Pick<User, PrivateUserKeys> {
	locale: string;
}

@Entity("users")
export class User extends BaseClass {
	@Column()
	username: string; // username max length 32, min 2 (should be configurable)

	@Column()
	discriminator: string; // opaque string: 4 digits on discord.com

	@Column({ nullable: true })
	avatar?: string; // hash of the user avatar

	@Column({ nullable: true })
	accent_color?: number; // banner color of user

	@Column({ nullable: true })
	banner?: string; // hash of the user banner

	@Column({ nullable: true, type: "simple-array" })
	theme_colors?: number[]; // TODO: Separate `User` and `UserProfile` models

	@Column({ nullable: true })
	pronouns?: string;

	@Column({ nullable: true, select: false })
	phone?: string; // phone number of the user

	@Column({ select: false })
	desktop: boolean = false; // if the user has desktop app installed

	@Column({ select: false })
	mobile: boolean = false; // if the user has mobile app installed

	@Column()
	premium: boolean = Config.get().defaults.user.premium; // if user bought individual premium

	@Column()
	premium_type: number = Config.get().defaults.user.premiumType; // individual premium level

	@Column()
	bot: boolean = false; // if user is bot

	@Column()
	bio: string = ""; // short description of the user (max 190 chars -> should be configurable)

	@Column()
	system: boolean = false; // shouldn't be used, the api sends this field type true, if the generated message comes from a system generated author

	@Column({ select: false })
	nsfw_allowed: boolean = true; // if the user can do age-restricted actions (NSFW channels/guilds/commands) // TODO: depending on age

	@Column({ select: false })
	mfa_enabled: boolean = false; // if multi factor authentication is enabled

	@Column({ select: false, nullable: true })
	totp_secret?: string = "";

	@Column({ nullable: true, select: false })
	totp_last_ticket?: string = "";

	@Column()
	created_at: Date = new Date(); // registration date

	@Column({ nullable: true })
	premium_since: Date; // premium date

	@Column({ select: false })
	verified: boolean = Config.get().defaults.user.verified; // email is verified

	@Column()
	disabled: boolean = false; // if the account is disabled

	@Column()
	deleted: boolean = false; // if the user was deleted

	@Column({ nullable: true, select: false })
	email?: string; // email of the user

	@Column()
	flags: string = "0"; // UserFlags // TODO: generate

	@Column()
	public_flags: number = 0;

	@Column()
	purchased_flags: number = 0;

	@Column()
	premium_usage_flags: number = 0;

	@Column({ type: "bigint" })
	rights: string;

	@OneToMany(() => Session, (session: Session) => session.user)
	sessions: Session[];

	@JoinColumn({ name: "relationship_ids" })
	@OneToMany(
		() => Relationship,
		(relationship: Relationship) => relationship.from,
		{
			cascade: true,
			orphanedRowAction: "delete",
		},
	)
	relationships: Relationship[];

	@JoinColumn({ name: "connected_account_ids" })
	@OneToMany(
		() => ConnectedAccount,
		(account: ConnectedAccount) => account.user,
		{
			cascade: true,
			orphanedRowAction: "delete",
		},
	)
	connected_accounts: ConnectedAccount[];

	@Column({ type: "simple-json", select: false })
	data: {
		valid_tokens_since: Date; // all tokens with a previous issue date are invalid
		hash?: string; // hash of the password, salt is saved in password (bcrypt)
	};

	@Column({ type: "simple-array", select: false })
	fingerprints: string[] = []; // array of fingerprints -> used to prevent multiple accounts

	@OneToOne(() => UserSettings, {
		cascade: true,
		orphanedRowAction: "delete",
		eager: false,
	})
	@JoinColumn()
	settings: UserSettings;

	// workaround to prevent fossord-unaware clients from deleting settings not used by them
	@Column({ type: "simple-json", select: false })
	extended_settings: string = "{}";

	// TODO: I don't like this method?
	validate() {
		if (this.email) {
			this.email = adjustEmail(this.email);
			if (!this.email)
				throw FieldErrors({
					email: { message: "Invalid email", code: "EMAIL_INVALID" },
				});
			if (!this.email.match(/([a-z\d.-]{3,})@([a-z\d.-]+).([a-z]{2,})/g))
				throw FieldErrors({
					email: { message: "Invalid email", code: "EMAIL_INVALID" },
				});
		}

		if (this.discriminator) {
			const discrim = Number(this.discriminator);
			if (this.discriminator.length > 4)
				throw FieldErrors({
					discriminator: {
						message: "Discriminator cannot be more than 4 digits.",
						code: "DISCRIMINATOR_INVALID",
					},
				});
			if (isNaN(discrim))
				throw FieldErrors({
					discriminator: {
						message: "Discriminator must be a number.",
						code: "DISCRIMINATOR_INVALID",
					},
				});
			if (discrim <= 0 || discrim >= 10000)
				throw FieldErrors({
					discriminator: {
						message: "Discriminator must be a number.",
						code: "DISCRIMINATOR_INVALID",
					},
				});
			this.discriminator = discrim.toString().padStart(4, "0");
		}
	}

	toPublicUser() {
		const user: any = {};
		PublicUserProjection.forEach((x) => {
			user[x] = this[x];
		});
		return user as PublicUser;
	}

	static async getPublicUser(user_id: string, opts?: FindOneOptions<User>) {
		return await User.findOneOrFail({
			where: { id: user_id },
			...opts,
			//@ts-ignore
			select: [...PublicUserProjection, ...(opts?.select || [])], // TODO: fix
		});
	}

	public static async generateDiscriminator(
		username: string,
	): Promise<string | undefined> {
		if (Config.get().register.incrementingDiscriminators) {
			// discriminator will be incrementally generated

			// First we need to figure out the currently highest discrimnator for the given username and then increment it
			const users = await User.find({
				where: { username },
				select: ["discriminator"],
			});
			const highestDiscriminator = Math.max(
				0,
				...users.map((u) => Number(u.discriminator)),
			);

			const discriminator = highestDiscriminator + 1;
			if (discriminator >= 10000) {
				return undefined;
			}

			return discriminator.toString().padStart(4, "0");
		} else {
			// discriminator will be randomly generated

			// randomly generates a discriminator between 1 and 9999 and checks max five times if it already exists
			// TODO: is there any better way to generate a random discriminator only once, without checking if it already exists in the database?
			for (let tries = 0; tries < 5; tries++) {
				const discriminator = Math.randomIntBetween(1, 9999)
					.toString()
					.padStart(4, "0");
				const exists = await User.findOne({
					where: { discriminator, username: username },
					select: ["id"],
				});
				if (!exists) return discriminator;
			}

			return undefined;
		}
	}

	static async register({
		email,
		username,
		password,
		date_of_birth,
		id,
		req,
	}: {
		username: string;
		password?: string;
		email?: string;
		date_of_birth?: Date; // "2000-04-03"
		id?: string;
		req?: any;
	}) {
		// trim special uf8 control characters -> Backspace, Newline, ...
		username = trimSpecial(username);

		const discriminator = await User.generateDiscriminator(username);
		if (!discriminator) {
			// We've failed to generate a valid and unused discriminator
			throw FieldErrors({
				username: {
					code: "USERNAME_TOO_MANY_USERS",
					message: req.t("auth:register.USERNAME_TOO_MANY_USERS"),
				},
			});
		}

		// TODO: save date_of_birth
		// appearently discord doesn't save the date of birth and just calculate if nsfw is allowed
		// if nsfw_allowed is null/undefined it'll require date_of_birth to set it to true/false
		const language =
			req.language === "en" ? "en-US" : req.language || "en-US";

		const settings = UserSettings.create({
			locale: language,
		});

		const user = User.create({
			username: username,
			discriminator,
			id: id || Snowflake.generate(),
			email: email,
			data: {
				hash: password,
				valid_tokens_since: new Date(),
			},
			extended_settings: "{}",
			premium_since: Config.get().defaults.user.premium
				? new Date()
				: undefined,
			settings: settings,
			rights: Config.get().register.defaultRights,
		});

		user.validate();
		await Promise.all([user.save(), settings.save()]);

		setImmediate(async () => {
			if (Config.get().guild.autoJoin.enabled) {
				for (const guild of Config.get().guild.autoJoin.guilds || []) {
					await Member.addToGuild(user.id, guild).catch((e) => {});
				}
			}
		});

		return user;
	}
}

export const CUSTOM_USER_FLAG_OFFSET = BigInt(1) << BigInt(32);

export class UserFlags extends BitField {
	static FLAGS = {
		DISCORD_EMPLOYEE: BigInt(1) << BigInt(0),
		PARTNERED_SERVER_OWNER: BigInt(1) << BigInt(1),
		HYPESQUAD_EVENTS: BigInt(1) << BigInt(2),
		BUGHUNTER_LEVEL_1: BigInt(1) << BigInt(3),
		MFA_SMS: BigInt(1) << BigInt(4),
		PREMIUM_PROMO_DISMISSED: BigInt(1) << BigInt(5),
		HOUSE_BRAVERY: BigInt(1) << BigInt(6),
		HOUSE_BRILLIANCE: BigInt(1) << BigInt(7),
		HOUSE_BALANCE: BigInt(1) << BigInt(8),
		EARLY_SUPPORTER: BigInt(1) << BigInt(9),
		TEAM_USER: BigInt(1) << BigInt(10),
		TRUST_AND_SAFETY: BigInt(1) << BigInt(11),
		SYSTEM: BigInt(1) << BigInt(12),
		HAS_UNREAD_URGENT_MESSAGES: BigInt(1) << BigInt(13),
		BUGHUNTER_LEVEL_2: BigInt(1) << BigInt(14),
		UNDERAGE_DELETED: BigInt(1) << BigInt(15),
		VERIFIED_BOT: BigInt(1) << BigInt(16),
		EARLY_VERIFIED_BOT_DEVELOPER: BigInt(1) << BigInt(17),
		CERTIFIED_MODERATOR: BigInt(1) << BigInt(18),
		BOT_HTTP_INTERACTIONS: BigInt(1) << BigInt(19),
	};
}
