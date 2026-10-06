import { Router, type IRouter } from "express";
import healthRouter from "./health";
import transitRouter from "./transit";

const router: IRouter = Router();

router.use(healthRouter);
router.use(transitRouter);

export default router;
