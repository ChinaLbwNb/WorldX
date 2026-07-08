import { Router } from "express";
import type { Request, Response } from "express";
import * as authStore from "../../store/auth-store.js";
import * as userCharacterStore from "../../store/user-character-store.js";
import { appContext } from "../../services/app-context.js";
import { getBearerToken, getAuthenticatedUser } from "../request-user.js";

const router = Router();

function sendAuth(res: Response, result: {
  user: authStore.AuthUser;
  token: string;
  expiresAt: number;
}) {
  res.cookie("worldx_session", result.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    expires: new Date(result.expiresAt),
    path: "/",
  });
  userCharacterStore.ensureUser(result.user.id, result.user.displayName);
  if (appContext.hasWorld && appContext.playerManager) {
    appContext.playerManager.createStarterUserCharactersForNewAccount(result.user.id);
  }
  res.json({
    ok: true,
    user: result.user,
    token: result.token,
    expiresAt: result.expiresAt,
  });
}

router.post("/register", (req: Request, res: Response) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName : undefined;
    const result = authStore.registerUser({ username, password, displayName });
    sendAuth(res, result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/login", (req: Request, res: Response) => {
  try {
    const username = typeof req.body?.username === "string" ? req.body.username : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    sendAuth(res, authStore.loginUser({ username, password }));
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/me", (req: Request, res: Response) => {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  userCharacterStore.ensureUser(user.id, user.displayName);
  res.json({ ok: true, user });
});

router.post("/logout", (req: Request, res: Response) => {
  authStore.revokeSession(getBearerToken(req));
  res.clearCookie("worldx_session", { path: "/" });
  res.json({ ok: true });
});

export default router;
