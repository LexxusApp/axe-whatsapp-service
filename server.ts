import "dotenv/config";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  proto,
  useMultiFileAuthState,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
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
const SESSIONS_ROOT = path.resolve(process.env.SESSIONS_DIR ?? "./sessions");
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? "silent" });
/** Máximo de `startBaileysForTenant` automáticos seguidos sem `connection === "open"` (evita loop no Railway). */
const BAILEYS_MAX_AUTO_RECONNECT = Math.max(
  0,
  Number.parseInt(process.env.BAILEYS_MAX_AUTO_RECONNECT ?? "15", 10) || 15,
);

/** Nome da tabela em `public` (PostgREST: `public.whatsapp_sessions`). */
const WHATSAPP_SESSIONS_TABLE = "whatsapp_sessions";

/** Encadeia `.schema("public")` para todas as operações em `whatsapp_sessions`. */
function whatsappSessionsFrom(client: SupabaseClient) {
  return client.schema("public").from(WHATSAPP_SESSIONS_TABLE);
}

const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
let supabaseAdmin: SupabaseClient | null = null;
if (supabaseUrl && supabaseServiceKey) {
  supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
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

  const { data: row, error: loadError } = await whatsappSessionsFrom(client)
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
    const { error } = await whatsappSessionsFrom(client).upsert(
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
  /** Se true (padrão), na próxima falha recuperável pode apagar credenciais em disco uma vez até novo POST /start. */
  allowLocalAuthResetOnFailure?: boolean;
  /** Tentativas de reinício automático desde a última vez que a conexão ficou `open` (cap em BAILEYS_MAX_AUTO_RECONNECT). */
  autoReconnectCount?: number;
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
      autoReconnectCount: 0,
    } satisfies TenantSession;
    tenantSessions.set(tenantId, s);
  }
  return s;
}

function disconnectReasonName(code: number | undefined): string {
  if (code === undefined) return "undefined";
  const map: Record<number, string> = {
    [DisconnectReason.connectionClosed]: "connectionClosed",
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

function shouldWipeLocalAuthOnDisconnect(statusCode: number | undefined, boomMessage: string): boolean {
  const msg = boomMessage.toLowerCase();
  if (msg.includes("connection failure")) return true;
  if (msg.includes("connect") && msg.includes("fail")) return true;
  if (statusCode === DisconnectReason.restartRequired) return true;
  if (statusCode === DisconnectReason.badSession) return true;
  if (statusCode === DisconnectReason.multideviceMismatch) return true;
  if (statusCode === DisconnectReason.forbidden) return true;
  return false;
}

async function wipeAuthStorage(tenantId: string): Promise<void> {
  if (supabaseAdmin) {
    const { error } = await whatsappSessionsFrom(supabaseAdmin).delete().eq("id", tenantId);
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
    const { error } = await whatsappSessionsFrom(supabaseAdmin)
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

type StartBaileysOptions = {
  /** true quando o reinício vem do handler connection.update (não redefine allowLocalAuthResetOnFailure). */
  isAutoReconnect?: boolean;
};

async function startBaileysForTenant(tenantId: string, opts?: StartBaileysOptions): Promise<void> {
  const session = getSession(tenantId);
  if (!opts?.isAutoReconnect) {
    session.allowLocalAuthResetOnFailure = true;
    session.autoReconnectCount = 0;
    console.log(`[WP][${tenantId}] startBaileys: pedido novo (API ou primeiro start). allowLocalAuthResetOnFailure=true`);
  } else {
    const nextAttempt = (session.autoReconnectCount ?? 0) + 1;
    if (BAILEYS_MAX_AUTO_RECONNECT > 0 && nextAttempt > BAILEYS_MAX_AUTO_RECONNECT) {
      const msg = `Limite de auto-reconexão (${BAILEYS_MAX_AUTO_RECONNECT} tentativas) atingido; parando para evitar loop. Use POST /api/whatsapp/session para tentar de novo.`;
      console.error(`[WP][${tenantId}] ${msg}`);
      session.status = "closed";
      session.lastError = msg;
      session.socket = null;
      return;
    }
    session.autoReconnectCount = nextAttempt;
    console.log(
      `[WP][${tenantId}] startBaileys: reinício automático (${session.autoReconnectCount}/${BAILEYS_MAX_AUTO_RECONNECT || "∞"}).`,
    );
  }

  session.lastError = null;
  session.status = "connecting";
  session.qrRaw = null;
  session.qrDataUrl = null;

  if (!opts?.isAutoReconnect) {
    console.log(`[WP][${tenantId}] Etapa 1/6: verificando Supabase (acessível para este tenant)…`);
    await logSupabaseReachableForTenant(tenantId);
  } else {
    console.log(`[WP][${tenantId}] Etapa 1/6: auto-reconnect — pulando reteste Supabase (cliente já validado neste processo).`);
  }

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

  console.log(`[WP][${tenantId}] Etapa 5/6: makeWASocket…`);
  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    printQRInTerminal: false,
    syncFullHistory: false,
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
      session.status = "closed";
      session.qrRaw = null;
      session.qrDataUrl = null;

      const boomError = lastDisconnect?.error as Boom | undefined;
      const statusCode = boomError?.output?.statusCode;
      const boomMsg = boomError?.message ?? String(lastDisconnect?.error ?? "");
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`[WP][${tenantId}] Conexão FECHADA:`, {
        boomMessage: boomMsg,
        statusCode,
        disconnectReason: disconnectReasonName(statusCode),
        shouldReconnect,
        loggedOut: statusCode === DisconnectReason.loggedOut,
        lastDisconnectDate: lastDisconnect?.date?.toISOString?.() ?? lastDisconnect?.date,
        output: boomError?.output,
      });

      if (boomError) {
        session.lastError = boomError.message;
      }

      session.socket = null;

      const wipeRecommended = shouldWipeLocalAuthOnDisconnect(statusCode, boomMsg);
      const mayWipe = wipeRecommended && (session.allowLocalAuthResetOnFailure !== false);
      console.log(`[WP][${tenantId}] Política pós-falha: wipeRecommended=${wipeRecommended} mayWipe=${mayWipe} allowFlag=${session.allowLocalAuthResetOnFailure}`);

      if (shouldReconnect) {
        const delayMs = 2500;
        console.log(`[WP][${tenantId}] Agendando reinício em ${delayMs}ms…`);
        setTimeout(() => {
          void (async () => {
            const sess = getSession(tenantId);
            const doWipe = shouldWipeLocalAuthOnDisconnect(statusCode, boomMsg) && sess.allowLocalAuthResetOnFailure !== false;
            if (doWipe) {
              console.log(
                `[WP][${tenantId}] Limpando sessão antiga no disco e criando instância nova do zero (uma vez neste ciclo).`,
              );
              sess.allowLocalAuthResetOnFailure = false;
              await wipeAuthStorage(tenantId);
            }
            try {
              await startBaileysForTenant(tenantId, { isAutoReconnect: true });
              console.log(`[WP][${tenantId}] Reinício automático concluiu startBaileysForTenant.`);
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e);
              console.error(`[WP][${tenantId}] Reinício automático falhou:`, msg);
              getSession(tenantId).lastError = msg;
              getSession(tenantId).status = "closed";
            }
          })();
        }, delayMs);
      } else {
        console.log(`[WP][${tenantId}] Não reconectar (logged out ou equivalente).`);
      }
    } else if (connection === "open") {
      session.status = "open";
      session.qrRaw = null;
      session.qrDataUrl = null;
      session.lastError = null;
      session.autoReconnectCount = 0;
      console.log(`[WP][${tenantId}] Conexão ABERTA (WhatsApp pronto).`);
    } else if (connection === "connecting") {
      console.log(`[WP][${tenantId}] Conexão em estado connecting…`);
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

/** Alias para o frontend (Vercel): mesmo comportamento que POST /api/whatsapp/session */
app.post("/whatsapp/start", async (req, res) => {
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

/**
 * Corpo JSON: { "tenant_id": "<uuid do Supabase>" }
 * Cada zelador usa um tenant_id distinto; com Supabase configurado a sessão Baileys fica em `public.whatsapp_sessions` (colunas id, data);
 * sem Supabase, uso apenas disco em ./sessions/<tenant_id>/.
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
  console.log(
    `Axé WhatsApp (Baileys) ouvindo na porta ${PORT} (Number(process.env.PORT || 8080))`,
  );
  console.log(`Pasta de sessões: ${SESSIONS_ROOT}`);
});
