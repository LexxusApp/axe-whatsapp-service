import "dotenv/config";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import {
  createClient,
  type SupabaseClient,
  type WebSocketLikeConstructor,
} from "@supabase/supabase-js";
import cors from "cors";
import express from "express";
import type { NextFunction } from "express";
import { mkdir } from "fs/promises";
import path from "path";
import pino from "pino";
import QRCode from "qrcode";
import WebSocket from "ws";

process.on("unhandledRejection", (reason: unknown) => {
  console.error("[WP] unhandledRejection (servidor continua):", reason);
});

const app = express();

const vercelAppOrigin = "https://axecloud-app.vercel.app";
const corsEnv = process.env.CORS_ORIGIN?.trim();
const corsExtraOrigins =
  corsEnv && corsEnv !== "*"
    ? corsEnv.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
const corsAllowedOrigins = Array.from(
  new Set<string>([vercelAppOrigin, ...corsExtraOrigins]),
);

app.use(
  cors({
    origin:
      corsEnv === "*"
        ? true
        : corsAllowedOrigins.length === 1
          ? corsAllowedOrigins[0]
          : corsAllowedOrigins,
  }),
);
app.use(express.json());

const PORT = Number(process.env.PORT) || 3000;
const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR ?? "./sessions");
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "silent" });

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
let supabaseAdmin: SupabaseClient | null = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
} else {
  console.warn(
    "[WP] Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Railway para confirmações SIM/NÃO em convites de evento.",
  );
}

type SessionStatus = "idle" | "connecting" | "qr" | "open" | "closed";

type TenantSession = {
  socket: ReturnType<typeof makeWASocket> | null;
  qrRaw: string | null;
  qrDataUrl: string | null;
  status: SessionStatus;
  lastError: string | null;
};

const tenantSessions = new Map<string, TenantSession>();

function sanitizeTenantId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128) {
    throw new Error("tenant_id inválido");
  }
  if (/[\\/]/.test(trimmed) || trimmed.includes("..")) {
    throw new Error("tenant_id não pode conter caminhos");
  }
  return trimmed;
}

function getSession(tenantId: string): TenantSession {
  let s = tenantSessions.get(tenantId);
  if (!s) {
    s = {
      socket: null,
      qrRaw: null,
      qrDataUrl: null,
      status: "idle",
      lastError: null,
    };
    tenantSessions.set(tenantId, s);
  }
  return s;
}

async function sendWhatsAppTextForTenant(
  tenantId: string,
  numero: string,
  texto: string,
): Promise<boolean> {
  const session = getSession(tenantId);
  const sock = session.socket;
  if (!sock || session.status !== "open") return false;
  try {
    let jid = numero;
    if (!numero.includes("@")) {
      let cleanNumber = numero.replace(/\D/g, "");
      if (!cleanNumber.startsWith("55")) cleanNumber = `55${cleanNumber}`;
      jid = `${cleanNumber}@s.whatsapp.net`;
    }
    await sock.sendMessage(jid, { text: texto });
    return true;
  } catch {
    return false;
  }
}

function attachConviteInboundHandler(tenantId: string, sock: ReturnType<typeof makeWASocket>) {
  if (!supabaseAdmin) return;

  sock.ev.on("messages.upsert", async (event) => {
    try {
      const msg = event.messages?.[0];
      if (!msg?.message || msg.key?.fromMe) return;

      const senderJid = msg.key?.remoteJid;
      const textMessage =
        msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (!textMessage || !senderJid) return;

      const cleanText = String(textMessage).trim().toUpperCase();
      const isConfirmation =
        cleanText.startsWith("SIM") ||
        cleanText.startsWith("NAO") ||
        cleanText.startsWith("NÃO");
      if (!isConfirmation) return;

      const match = cleanText.match(/^(SIM|NAO|NÃO)(?:\s+(\d{8,11}))?\s*$/i);
      if (!match) return;

      const action = match[1].toUpperCase();
      const extractedPhoneFromText = match[2];
      const isLid = senderJid.includes("@lid");
      const defaultSenderPhone = senderJid.replace(/[^0-9]/g, "");
      const newStatus = action === "SIM" ? "Confirmado" : "Recusado";

      const searchPhone = extractedPhoneFromText || defaultSenderPhone;
      const last8 = searchPhone.slice(-8);

      const { data: convites, error: queryError } = await supabaseAdmin
        .from("convidados_eventos")
        .select("*")
        .eq("tenant_id", tenantId)
        .ilike("telefone", `%${last8}`);

      if (queryError) return;

      if (convites && convites.length > 0) {
        const convitesPendentes = convites.filter((c: { status: string }) => c.status !== newStatus);
        for (const convite of convitesPendentes) {
          await supabaseAdmin.from("convidados_eventos").update({ status: newStatus }).eq("id", convite.id);
        }

        if (convitesPendentes.length > 0) {
          const confirmMsg =
            action === "SIM"
              ? "Axé! Sua presença foi confirmada com sucesso. Aguardamos você!"
              : "Agradecemos o aviso! Sua ausência foi registrada. Pai/Mãe Oxalá abençoe!";
          await sendWhatsAppTextForTenant(tenantId, senderJid, confirmMsg);
        } else {
          await sendWhatsAppTextForTenant(
            tenantId,
            senderJid,
            `Seu status já constava como ${newStatus} em nosso sistema! Axé.`,
          );
        }
      } else if (isLid && !extractedPhoneFromText) {
        const fallbackMsg =
          "Axé! Recebemos sua mensagem, mas por questões de privacidade do WhatsApp Comercial, não conseguimos identificar seu número de telefone original automaticamente.\n\nPara confirmarmos sua presença no sistema, por favor reenvie sua resposta incluindo seu número com DDD.\n\n*Exemplo: SIM 11999999999*";
        await sendWhatsAppTextForTenant(tenantId, senderJid, fallbackMsg);
      } else {
        const errorMsg =
          "Não localizamos nenhum convite pendente para este número de telefone no sistema do Terreiro. Houve alguma alteração de número?";
        await sendWhatsAppTextForTenant(tenantId, senderJid, errorMsg);
      }
    } catch {
      /* não derrubar o consumer Baileys */
    }
  });
}

function requireWhatsappProxySecret(req: express.Request, res: express.Response, next: NextFunction) {
  const need = process.env.AXE_WHATSAPP_PROXY_SECRET?.trim();
  if (!need) return next();
  const got = String(req.headers["x-axe-whatsapp-proxy-secret"] ?? "");
  if (got !== need) {
    return res.status(401).json({ error: "Unauthorized", code: "WHATSAPP_PROXY_AUTH" });
  }
  next();
}

async function destroySocket(session: TenantSession): Promise<void> {
  const sock = session.socket;
  session.socket = null;
  if (!sock) return;
  try {
    await sock.logout();
  } catch {
    try {
      sock.end(undefined);
    } catch {
      /* ignore */
    }
  }
}

async function startBaileysForTenant(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  session.lastError = null;
  session.status = "connecting";
  session.qrRaw = null;
  session.qrDataUrl = null;

  await destroySocket(session);

  const authFolder = path.join(SESSIONS_ROOT, tenantId);
  await mkdir(authFolder, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  session.socket = sock;

  sock.ev.on("creds.update", saveCreds);
  attachConviteInboundHandler(tenantId, sock);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
      } catch {
        session.qrDataUrl = null;
      }
      session.qrRaw = qr;
      session.status = "qr";
    }

    if (connection === "close") {
      session.status = "closed";
      session.qrRaw = null;
      session.qrDataUrl = null;

      const boomError = lastDisconnect?.error as Boom | undefined;
      const statusCode = boomError?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (boomError) {
        session.lastError = boomError.message;
      }

      session.socket = null;

      if (shouldReconnect) {
        setTimeout(() => {
          void startBaileysForTenant(tenantId).catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : String(e);
            getSession(tenantId).lastError = msg;
            getSession(tenantId).status = "closed";
          });
        }, 2500);
      }
    } else if (connection === "open") {
      session.status = "open";
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.lastError = null;
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "axe-whatsapp-baileys" });
});

/** Alias para o frontend (Vercel): mesmo payload que GET /api/whatsapp/session/:tenantId/status */
app.get("/whatsapp/status", (req, res) => {
  try {
    const raw =
      String(req.query.tenant_id ?? "").trim() ||
      String(req.headers["x-tenant-id"] ?? "").trim();
    const tenantId = sanitizeTenantId(raw);
    const s = getSession(tenantId);
    res.json({
      tenant_id: tenantId,
      status: s.status,
      last_error: s.lastError,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

/**
 * Corpo JSON: { "tenant_id": "<uuid do Supabase>" }
 * Cada zelador usa um tenant_id distinto; a sessão fica em ./sessions/<tenant_id>/.
 */
app.post("/api/whatsapp/session", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(String(req.body?.tenant_id ?? ""));
    await startBaileysForTenant(tenantId);
    const s = getSession(tenantId);
    res.status(202).json({
      tenant_id: tenantId,
      status: s.status,
      message:
        s.status === "qr"
          ? "Escaneie o QR em GET /api/whatsapp/session/:tenantId/qr"
          : "Conexão iniciada; consulte o status e o QR nas rotas GET.",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro ao iniciar sessão";
    res.status(400).json({ error: message });
  }
});

app.post("/api/whatsapp/session/:tenantId/start", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    await startBaileysForTenant(tenantId);
    const s = getSession(tenantId);
    res.status(202).json({
      tenant_id: tenantId,
      status: s.status,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro ao iniciar sessão";
    res.status(400).json({ error: message });
  }
});

app.get("/api/whatsapp/session/:tenantId/qr", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    if (!s.qrRaw && s.status !== "open") {
      return res.status(404).json({
        tenant_id: tenantId,
        error: "Nenhum QR disponível ainda. Chame POST .../session com este tenant_id.",
        status: s.status,
      });
    }
    if (s.status === "open") {
      return res.json({
        tenant_id: tenantId,
        status: "open",
        message: "Já conectado ao WhatsApp; não é necessário QR.",
      });
    }
    return res.json({
      tenant_id: tenantId,
      status: s.status,
      qr_raw: s.qrRaw,
      qr_image_data_url: s.qrDataUrl,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.get("/api/whatsapp/session/:tenantId/status", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    res.json({
      tenant_id: tenantId,
      status: s.status,
      last_error: s.lastError,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.post("/api/whatsapp/session/:tenantId/logout", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    await destroySocket(s);
    s.status = "idle";
    s.qrRaw = null;
    s.qrDataUrl = null;
    s.lastError = null;
    res.json({ tenant_id: tenantId, status: "idle", message: "Sessão encerrada no servidor." });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

/**
 * Envio server-to-server (AxéCloud → Railway). Requer o mesmo AXE_WHATSAPP_PROXY_SECRET nos dois lados, se configurado.
 * Header x-tenant-id ou body.tenant_id identifica o zelador.
 */
app.post("/api/whatsapp/send", requireWhatsappProxySecret, async (req, res) => {
  try {
    const tenantFromHeader = String(req.headers["x-tenant-id"] ?? "").trim();
    const tenantFromBody = String((req.body as { tenant_id?: string })?.tenant_id ?? "").trim();
    const tenantId = sanitizeTenantId(tenantFromHeader || tenantFromBody);
    const phone = String((req.body as { phone?: string })?.phone ?? "").trim();
    const message = String((req.body as { message?: string })?.message ?? "").trim();
    if (!phone || !message) {
      return res.status(400).json({ error: "phone e message são obrigatórios" });
    }
    const ok = await sendWhatsAppTextForTenant(tenantId, phone, message);
    if (!ok) {
      return res.status(400).json({
        error: "WhatsApp não conectado para este tenant no servidor de mensageria.",
      });
    }
    res.json({ success: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro";
    res.status(400).json({ error: message });
  }
});

app.use((req, res) => {
  console.warn(
    `[WP] 404 ${req.method} ${req.originalUrl} host=${req.get("host") ?? ""} origin=${req.get("origin") ?? ""}`,
  );
  res.status(404).json({ error: "Not Found", path: req.originalUrl });
});

app.listen(PORT, () => {
  console.log(`Axé WhatsApp (Baileys) ouvindo na porta ${PORT} (process.env.PORT)`);
  console.log(`Pasta de sessões: ${SESSIONS_ROOT}`);
});
