import { Router } from "express";
import type { Request, Response } from "express";
import { getRequestUserId, normalizeUserId } from "../request-user.js";
import * as authStore from "../../store/auth-store.js";
import { deleteAccountCascade } from "../../store/account-deletion-store.js";
import { appContext } from "../../services/app-context.js";

const router = Router();

function accountView(user: authStore.AuthUser | null) {
  if (!user) return null;
  const row = authStore.getAuthDb()
    .prepare("SELECT COUNT(*) AS count FROM account_user_characters WHERE user_id = ?")
    .get(user.id) as { count?: number } | undefined;
  return {
    id: user.id,
    displayName: user.displayName,
    characterCount: Number(row?.count ?? 0),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

router.get("/", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const user = authStore.getUserById(userId);
  res.json({ users: accountView(user) ? [accountView(user)] : [] });
});

router.get("/me", (req: Request, res: Response) => {
  const userId = getRequestUserId(req);
  const user = authStore.getUserById(userId);
  res.json({ userId, user: accountView(user) });
});

router.post("/", (_req: Request, res: Response) => {
  res.status(410).json({ error: "Use /api/auth/register to create accounts" });
});

router.patch("/:id", (req: Request, res: Response) => {
  const currentUserId = getRequestUserId(req);
  const targetUserId = normalizeUserId(req.params.id);
  if (targetUserId !== currentUserId) {
    res.status(403).json({ error: "Accounts can only update their own profile" });
    return;
  }
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim().slice(0, 32) : "";
  if (!displayName) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }
  const user = authStore.updateAuthUserDisplayName(currentUserId, displayName);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json({ ok: true, user: accountView(user) });
});

router.delete("/:id", (req: Request, res: Response) => {
  const currentUserId = getRequestUserId(req);
  const targetUserId = normalizeUserId(req.params.id);
  if (targetUserId !== currentUserId) {
    res.status(403).json({ error: "Accounts can only delete themselves" });
    return;
  }
  try {
    const result = deleteAccountCascade({
      userId: currentUserId,
      activeWorldDir: appContext.getWorldDir(),
    });
    res.clearCookie("worldx_session", { path: "/" });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
