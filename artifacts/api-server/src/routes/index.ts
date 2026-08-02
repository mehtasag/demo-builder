import { Router, type IRouter } from "express";
import healthRouter from "./health";
import videosRouter from "./videos";
import dropboxRouter from "./dropbox";

const router: IRouter = Router();

router.use(healthRouter);
router.use(videosRouter);
router.use(dropboxRouter);

export default router;
