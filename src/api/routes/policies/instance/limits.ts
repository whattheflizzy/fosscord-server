import { Router, Request, Response } from "express";
import { route } from "@fosscord/api";
import { Config } from "@fosscord/util";
const router = Router();

router.get("/", route({}), async (req: Request, res: Response) => {
	const { limits } = Config.get();
	res.json(limits);
});

export default router;
