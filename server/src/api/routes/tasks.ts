import { Router } from "express";
import { getRequestUserId } from "../request-user.js";
import {
  getTutorialTask,
  isTutorialTaskEventType,
  recordTutorialTaskEvent,
  resetTutorialTask,
} from "../../store/tutorial-task-store.js";

const router = Router();

router.get("/tutorial", (req, res) => {
  const userId = getRequestUserId(req);
  res.json({
    userId,
    task: getTutorialTask(userId),
  });
});

router.post("/tutorial/progress", (req, res) => {
  const userId = getRequestUserId(req);
  const eventType = req.body?.eventType;
  if (!isTutorialTaskEventType(eventType)) {
    res.status(400).json({ error: "Unsupported tutorial task event type" });
    return;
  }
  const count = Number.isFinite(Number(req.body?.count)) ? Number(req.body.count) : 1;
  res.json({
    userId,
    task: recordTutorialTaskEvent(userId, eventType, count),
  });
});

router.post("/tutorial/reset", (req, res) => {
  const userId = getRequestUserId(req);
  res.json({
    userId,
    task: resetTutorialTask(userId),
  });
});

export default router;
