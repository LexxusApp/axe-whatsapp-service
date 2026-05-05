import "dotenv/config";
import { createHash } from "node:crypto";
import dns from "node:dns";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  type AuthenticationState,
} from "@whiskeysockets/baileys";

/** Evita escolher IPv6 primeiro no Docker/Railway (alguns caminhos até o WA falham no upgrade WS). */
dns.setDefaultResultOrder("ipv4first");
import { Mutex } from "async-mutex";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import cors from "cors";
import express from "express";
import type { NextFunction } from "express";
import { mkdir, rm } from "fs/promises";
import path from "path";
import pino from "pino";
import QRCode from "qrcode";

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

const PORT = Number(process.env.PORT || 8080);
const CONNECT_ROUTE_HINT =
  'O Baileys só inicia com POST /connect (corpo JSON: { "tenant_id": "<uuid>" } ou header x-tenant-id).';

const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR ?? "./sessions");
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "silent" });

/**
 * Versão do protocolo Web do WhatsApp usada pelo Baileys. Valores antigos costumam gerar
 * HTTP 405 "Method Not Allowed" no upgrade `wss://web.whatsapp.com/ws/chat`.
 * Sobrescreva com BAILEYS_WA_VERSION=2,3000,<terciário> (três inteiros) quando o fallback envelhecer.
 */
const WA_VERSION_FALLBACK: [number, number, number] = [2, 3000, 1034074495];

function parseWaVersionFromEnv(): [number, number, number] | null {
  const raw = process.env.BAILEYS_WA_VERSION?.trim();
  if (!raw) return null;
  const parts = raw.split(/[.,\s]+/).map((s) => Number.parseInt(s.trim(), 10));
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return [parts[0]!, parts[1]!, parts[2]!];
  }
  console.warn("[WP] BAILEYS_WA_VERSION deve ter 3 inteiros (ex: 2,3000,1034074495); ignorando.");
  return null;
}

function resolveWaVersion(): [number, number, number] {
  return parseWaVersionFromEnv() ?? WA_VERSION_FALLBACK;
}

/** Nome lógico da tabela (fisicamente em `public` via `db.schema` no cliente). PostgREST só aceita o nome da tabela em `.from()`, não `public.whatsapp_sessions`. */
const WHATSAPP_SESSIONS_TABLE = "whatsapp_sessions";

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
let supabaseAdmin: SupabaseClient | null = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    db: { schema: "public" },
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: {
      transport: ws as unknown as WebSocketLikeConstructor,
    },
  });
  console.log(
    "[WP] Supabase: SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY carregadas; cliente inicializado.",
  );
} else {
  console.warn(
    "[WP] Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no Railway para confirmações SIM/NÃO em convites de evento.",
  );
}

function reviveSessionFiles(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  return JSON.parse(JSON.stringify(raw), BufferJSON.reviver) as Record<string, unknown>;
}

/**
 * Mesma semântica de `useMultiFileAuthState`, mas persiste os arquivos virtuais em
 * `public.whatsapp_sessions` (colunas `id` = tenant, `data` = JSON do estado) via `.select()` / `.upsert()`.
 */
async function useSupabaseMultiFileAuthState(tenantId: string, client: SupabaseClient) {
  const mutex = new Mutex();
  const fixFileName = (file: string) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

  let filesMap: Record<string, unknown> = {};

  const { data: row, error: loadError } = await client
    .from("whatsapp_sessions")
    .select("data")
    .eq("id", tenantId)
    .maybeSingle();

  if (loadError) {
    console.warn(
      `[WP][${tenantId}] public.${WHATSAPP_SESSIONS_TABLE} select: ${loadError.message} (code=${loadError.code ?? "n/a"})`,
    );
  } else if (row?.data && typeof row.data === "object") {
    filesMap = reviveSessionFiles(row.data);
  }

  const persistLocked = async (): Promise<void> => {
    const data = JSON.parse(JSON.stringify(filesMap, BufferJSON.replacer)) as Record<string, unknown>;
    console.log("Tentando salvar sessão para:", tenantId);
    const { error } = await client.from("whatsapp_sessions").upsert(
      {
        id: tenantId,
        data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) {
      console.error(
        `[WP][${tenantId}] public.${WHATSAPP_SESSIONS_TABLE} upsert: ${error.message} (code=${error.code ?? "n/a"})`,
      );
    }
  };

  const writeData = async (data: unknown, file: string): Promise<void> => {
    const key = fixFileName(file);
    await mutex.runExclusive(async () => {
      filesMap[key] = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
      await persistLocked();
    });
  };

  const readData = async (file: string) => {
    const key = fixFileName(file);
    const v = filesMap[key];
    if (v === undefined || v === null) return null;
    return JSON.parse(JSON.stringify(v), BufferJSON.reviver);
  };

  const removeData = async (file: string): Promise<void> => {
    const key = fixFileName(file);
    await mutex.runExclusive(async () => {
      delete filesMap[key];
      await persistLocked();
    });
  };

  const creds = (await readData("creds.json")) || initAuthCreds();

  const state = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const data: Record<string, unknown> = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await readData(`${type}-${id}.json`);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            }
            data[id] = value;
          }),
        );
        return data;
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data)) {
          const bucket = data[category];
          if (!bucket) continue;
          for (const id of Object.keys(bucket)) {
            const value = bucket[id];
            const file = `${category}-${id}.json`;
            tasks.push(value ? writeData(value, file) : removeData(file));
          }
        }
        await Promise.all(tasks);
      },
    },
  } as unknown as AuthenticationState;

  return {
    state,
    saveCreds: async () => writeData(creds, "creds.json"),
  };
}

type SessionStatus = "idle" | "connecting" | "qr" | "open" | "closed";

type TenantSession = {
  socket: ReturnType<typeof makeWASocket> | null;
  qrRaw: string | null;
  qrDataUrl: string | null;
  status: SessionStatus;
  lastError: string | null;
  /** Se true (padrão), na próxima falha recuperável pode apagar credenciais em disco uma vez até novo POST /connect. */
  allowLocalAuthResetOnFailure?: boolean;
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
      allowLocalAuthResetOnFailure: true,
    } satisfies TenantSession;
    tenantSessions.set(tenantId, s);
  }
  return s;
}

function disconnectReasonName(code: number | undefined): string {
  if (code === undefined) return "undefined";
  const map: Record<number, string> = {
    [DisconnectReason.connectionClosed]: "connectionClosed",
    405: "http405_waWebSocketUpgrade_staleVersionOrNetworkBlock",
    408: "connectionLost_or_timedOut",
    [DisconnectReason.connectionReplaced]: "connectionReplaced",
    [DisconnectReason.loggedOut]: "loggedOut",
    [DisconnectReason.badSession]: "badSession",
    [DisconnectReason.restartRequired]: "restartRequired",
    [DisconnectReason.multideviceMismatch]: "multideviceMismatch",
    [DisconnectReason.forbidden]: "forbidden",
    [DisconnectReason.unavailableService]: "unavailableService",
  };
  return map[code] ?? `unknown_${code}`;
}

function logQrSnippetForRailway(tenantId: string, qr: string): void {
  const snippet =
    qr.length <= 40 ? qr : `${qr.slice(0, 16)}…${qr.slice(-12)} (${qr.length} chars)`;
  const sha16 = createHash("sha256").update(qr, "utf8").digest("hex").slice(0, 16);
  console.log(`[WP][${tenantId}] QR snippet="${snippet}" sha256_16=${sha16}`);
}

function isIntentionalLogoutError(message: string | null | undefined): boolean {
  if (!message) return false;
  return message.toLowerCase().includes("intentional logout");
}

function isLogoutOr401Disconnect(statusCode: number | undefined, boomMsg: string): boolean {
  if (statusCode === 401) return true;
  if (isIntentionalLogoutError(boomMsg)) return true;
  const m = boomMsg.toLowerCase();
  return m.includes("logged out") || m.includes("logout");
}

async function wipeAuthStorage(tenantId: string): Promise<void> {
  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from("whatsapp_sessions").delete().eq("id", tenantId);
    if (error) {
      console.warn(
        `[WP][${tenantId}] public.${WHATSAPP_SESSIONS_TABLE} delete: ${error.message} (code=${error.code ?? "n/a"})`,
      );
    } else {
      console.log(`[WP][${tenantId}] Linha removida em public.${WHATSAPP_SESSIONS_TABLE} (sessão zerada no Supabase).`);
    }
  }
  const folder = path.join(SESSIONS_ROOT, tenantId);
  console.log(`[WP][${tenantId}] Removendo pasta local de sessão (se existir): ${folder}`);
  await rm(folder, { recursive: true, force: true });
  console.log(`[WP][${tenantId}] Armazenamento de auth limpo; próximo start criará estado novo.`);
}

async function logSupabaseReachableForTenant(tenantId: string): Promise<void> {
  console.log(
    `[WP][${tenantId}] Supabase client inicializado=${Boolean(supabaseAdmin)}. Estado Baileys: ${supabaseAdmin ? `tabela public.${WHATSAPP_SESSIONS_TABLE}` : `apenas disco (${SESSIONS_ROOT})`}.`,
  );
  if (!supabaseAdmin) {
    console.warn(
      `[WP][${tenantId}] Sem SUPABASE_URL/SERVICE_ROLE_KEY — sessão só em disco; handler de convites (convidados_eventos) não roda.`,
    );
    return;
  }
  try {
    const { error } = await supabaseAdmin
      .from("whatsapp_sessions")
      .select("id")
      .eq("id", tenantId)
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(
        `[WP][${tenantId}] Supabase teste public.${WHATSAPP_SESSIONS_TABLE}: ${error.message} (code=${error.code ?? "n/a"})`,
      );
    } else {
      console.log(
        `[WP][${tenantId}] Supabase: select em public.${WHATSAPP_SESSIONS_TABLE} respondeu OK (linha opcional; ausência é normal em tenant novo).`,
      );
    }
  } catch (e: unknown) {
    console.warn(`[WP][${tenantId}] Supabase teste public.${WHATSAPP_SESSIONS_TABLE}: exceção`, e);
  }
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

async function destroySocket(session: TenantSession, tenantId: string, reason: string): Promise<void> {
  const sock = session.socket;
  session.socket = null;
  if (!sock) {
    console.log(`[WP][${tenantId}] destroySocket (${reason}): nenhum socket ativo.`);
    return;
  }
  console.log(`[WP][${tenantId}] destroySocket (${reason}): encerrando socket…`);
  try {
    await sock.logout();
    console.log(`[WP][${tenantId}] destroySocket: logout() concluído.`);
  } catch (e: unknown) {
    console.log(`[WP][${tenantId}] destroySocket: logout falhou (${e instanceof Error ? e.message : String(e)}), tentando end()…`);
    try {
      sock.end(undefined);
      console.log(`[WP][${tenantId}] destroySocket: end() chamado.`);
    } catch (e2: unknown) {
      console.log(`[WP][${tenantId}] destroySocket: end() também falhou —`, e2);
    }
  }
}

async function startBaileysForTenant(tenantId: string): Promise<void> {
  const session = getSession(tenantId);
  const previousLastError = session.lastError;

  session.allowLocalAuthResetOnFailure = true;
  console.log(`[WP][${tenantId}] startBaileys: acionado por POST /connect.`);

  if (isIntentionalLogoutError(previousLastError)) {
    console.log(
      `[WP][${tenantId}] Último erro foi Intentional Logout — limpando linha em public.${WHATSAPP_SESSIONS_TABLE} (id=${tenantId}) e pasta local antes de carregar auth / conectar.`,
    );
    await wipeAuthStorage(tenantId);
    session.allowLocalAuthResetOnFailure = true;
  }

  session.lastError = null;
  session.status = "connecting";
  session.qrRaw = null;
  session.qrDataUrl = null;

  console.log(`[WP][${tenantId}] Etapa 1/6: verificando Supabase (acessível para este tenant)…`);
  await logSupabaseReachableForTenant(tenantId);

  console.log(`[WP][${tenantId}] Etapa 2/6: destruindo socket anterior se existir…`);
  await destroySocket(session, tenantId, "antes de novo makeWASocket");

  const authFolder = path.join(SESSIONS_ROOT, tenantId);
  console.log(`[WP][${tenantId}] Etapa 3/6: pasta auth local=${authFolder} (fallback / limpeza)`);
  await mkdir(authFolder, { recursive: true });
  console.log(
    `[WP][${tenantId}] Etapa 4/6: ${supabaseAdmin ? `auth state Supabase (public.${WHATSAPP_SESSIONS_TABLE})` : "useMultiFileAuthState em disco"}…`,
  );
  const { state, saveCreds } = supabaseAdmin
    ? await useSupabaseMultiFileAuthState(tenantId, supabaseAdmin)
    : await useMultiFileAuthState(authFolder);
  const creds = state.creds;
  console.log(
    `[WP][${tenantId}] Credenciais carregadas: registered=${Boolean((creds as { registered?: boolean }).registered)} me=${(creds as { me?: { id?: string } }).me?.id ?? "n/a"}`,
  );

  const waVersion = resolveWaVersion();
  console.log(`[WP][${tenantId}] Etapa 5/6: makeWASocket (WA version ${waVersion.join(".")})…`);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    version: waVersion,
    browser: Browsers.windows("Chrome"),
    logger: baileysLogger,
    syncFullHistory: false,
    countryCode: "BR",
    markOnlineOnConnect: false,
    options: {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    },
  });
  session.socket = sock;
  console.log(`[WP][${tenantId}] Etapa 6/6: socket criado; registrando listeners (creds.update, connection.update, convites).`);

  sock.ev.on("creds.update", saveCreds);
  attachConviteInboundHandler(tenantId, sock);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[WP][${tenantId}] connection.update:`, {
      connection: connection ?? "undefined",
      hasQr: Boolean(qr),
      isNewLogin: update.isNewLogin,
      isOnline: update.isOnline,
      receivedPendingNotifications: update.receivedPendingNotifications,
    });

    if (qr) {
      logQrSnippetForRailway(tenantId, qr);
      console.log(`[WP][${tenantId}] QR recebido (${qr.length} chars); gerando data URL…`);
      try {
        session.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 256 });
      } catch (e: unknown) {
        console.warn(`[WP][${tenantId}] Falha ao gerar QRCode data URL:`, e);
        session.qrDataUrl = null;
      }
      session.qrRaw = qr;
      session.status = "qr";
      console.log(`[WP][${tenantId}] Status => qr`);
    }

    if (connection === "close") {
      const boomError = lastDisconnect?.error as Boom | undefined;
      const statusCode = boomError?.output?.statusCode;
      const boomMsg = boomError?.message ?? String(lastDisconnect?.error ?? "");

      if (statusCode === 403) {
        console.error(
          `[WP][${tenantId}] lastDisconnect statusCode=403 (forbidden) — limpando sessão e encerrando processo (código 1).`,
        );
        await wipeAuthStorage(tenantId);
        session.socket = null;
        session.status = "closed";
        session.qrRaw = null;
        session.qrDataUrl = null;
        process.exit(1);
      }

      if (isLogoutOr401Disconnect(statusCode, boomMsg)) {
        console.error(
          `[WP][${tenantId}] Logout ou 401 — limpando public.${WHATSAPP_SESSIONS_TABLE} e disco; encerrando processo (código 0). Após reinício do Railway, use POST /connect para novo QR.`,
        );
        await wipeAuthStorage(tenantId);
        session.socket = null;
        session.status = "closed";
        session.qrRaw = null;
        session.qrDataUrl = null;
        session.lastError = boomMsg;
        process.exit(0);
      }

      session.status = "closed";
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.socket = null;

      console.log(`[WP][${tenantId}] Conexão FECHADA:`, {
        boomMessage: boomMsg,
        statusCode,
        disconnectReason: disconnectReasonName(statusCode),
        lastDisconnectDate: lastDisconnect?.date?.toISOString?.() ?? lastDisconnect?.date,
        output: boomError?.output,
      });

      if (boomError) {
        session.lastError = boomError.message;
        if (statusCode === 405) {
          session.lastError = `${boomError.message} (HTTP 405 no WebSocket do WhatsApp: versão WA desatualizada ou bloqueio de rede. Ajuste BAILEYS_WA_VERSION ou o pacote Baileys; em datacenters o WA às vezes bloqueia IPs.)`;
        }
      }

      console.log(
        `[WP][${tenantId}] Sem auto-reconexão. Para gerar novo QR ou reconectar, envie POST /connect com este tenant_id.`,
      );
    } else if (connection === "open") {
      session.status = "open";
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.lastError = null;
      console.log(`[WP][${tenantId}] Conexão ABERTA (WhatsApp pronto).`);
    } else if (connection === "connecting") {
      console.log(`[WP][${tenantId}] Conexão em estado connecting…`);
    }
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "axe-whatsapp-baileys" });
});

/** Única rota que inicia o Baileys e pode disparar geração de QR. */
app.post("/connect", async (req, res) => {
  try {
    const tenantId = sanitizeTenantId(
      String(
        (req.body as { tenant_id?: string })?.tenant_id ??
          req.headers["x-tenant-id"] ??
          "",
      ),
    );
    await startBaileysForTenant(tenantId);
    const s = getSession(tenantId);
    res.status(202).json({
      tenant_id: tenantId,
      status: s.status,
      message:
        s.status === "qr"
          ? "QR disponível em GET /api/whatsapp/session/:tenantId/qr"
          : "Conexão iniciada; use GET /api/whatsapp/session/:tenantId/status para acompanhar.",
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Erro ao conectar";
    res.status(400).json({ error: message });
  }
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

/** @deprecated Use POST /connect */
app.post("/whatsapp/start", (_req, res) => {
  res.status(400).json({ error: CONNECT_ROUTE_HINT });
});

/**
 * @deprecated Use POST /connect
 * Sessão em `public.whatsapp_sessions` (id, data) quando Supabase está configurado.
 */
app.post("/api/whatsapp/session", (_req, res) => {
  res.status(400).json({ error: CONNECT_ROUTE_HINT });
});

/** @deprecated Use POST /connect */
app.post("/api/whatsapp/session/:tenantId/start", (_req, res) => {
  res.status(400).json({ error: CONNECT_ROUTE_HINT });
});

app.get("/api/whatsapp/session/:tenantId/qr", (req, res) => {
  try {
    const tenantId = sanitizeTenantId(req.params.tenantId);
    const s = getSession(tenantId);
    if (!s.qrRaw && s.status !== "open") {
      return res.status(404).json({
        tenant_id: tenantId,
        error: "Nenhum QR disponível ainda. Chame POST /connect com este tenant_id.",
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
    await destroySocket(s, tenantId, "POST logout");
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
  console.log("[WP] Aguardando comando para gerar QR...");
  console.log(
    `Axé WhatsApp (Baileys) ouvindo na porta ${PORT} (Number(process.env.PORT || 8080))`,
  );
  console.log(`Pasta de sessões: ${SESSIONS_ROOT}`);
});
