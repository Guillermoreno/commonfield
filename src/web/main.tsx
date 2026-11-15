import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import {
  buildInvitationUrl,
  parseInvitationFragment,
} from "../access-control/invitation-url.js";
import {
  TeamAccessPanel,
  type InvitationRow,
  type MemberRow,
} from "./team-access-panel.js";
import { invitationAddIntent } from "./invitation-composer-policy.js";
import {
  classifyWheelGesture,
  continueWheelGesture,
  sanitizeView,
  sortNotesForKeyboard,
  type GestureKind,
  type WheelSample,
} from "./navigation-policy.js";
import "./style.css";
type Sticky = {
  id: string;
  text: string;
  x: number;
  y: number;
  version: number;
  color: StickyColor;
};
type StickyColor = "yellow" | "pink" | "blue" | "green" | "orange" | "purple";
type SpatialOperationKind = "create" | "text" | "position" | "color";
type StickyFieldIntents = {
  text?: string;
  position?: { x: number; y: number };
  color?: StickyColor;
};
type InvitationDto = {
  invitationId: string;
  email: string;
  role: "member" | "administrator";
  lifecycleStatus: InvitationRow["lifecycle"];
  deliveryStatus:
    | "unsent"
    | Exclude<InvitationRow["delivery"], "not_requested">;
  invitationUrl?: string;
};
const invitationRow = (value: InvitationDto): InvitationRow => ({
  id: value.invitationId,
  email: value.email,
  role: value.role,
  lifecycle: value.lifecycleStatus,
  delivery:
    value.deliveryStatus === "unsent" ? "not_requested" : value.deliveryStatus,
  url: value.invitationUrl ?? "",
});
const invitationLabel = (value: string) =>
  value === "not_requested"
    ? "Unsent"
    : value
        .split("_")
        .map((part) => part[0]!.toUpperCase() + part.slice(1))
        .join(" ");
const STICKY_COLORS: ReadonlyArray<{ name: StickyColor; label: string }> = [
  { name: "yellow", label: "Yellow" },
  { name: "pink", label: "Pink" },
  { name: "blue", label: "Blue" },
  { name: "green", label: "Green" },
  { name: "orange", label: "Orange" },
  { name: "purple", label: "Purple" },
];
function mergeCommittedSticky(
  current: Sticky[],
  committed: Sticky,
  fieldIntents: ReadonlyMap<string, StickyFieldIntents>,
): Sticky[] {
  if (!current.some((note) => note.id === committed.id))
    return [...current, committed];
  return current.map((note) => {
    if (note.id !== committed.id) return note;
    const intent = fieldIntents.get(note.id);
    return {
      ...committed,
      text: intent?.text !== undefined ? note.text : committed.text,
      x: intent?.position !== undefined ? note.x : committed.x,
      y: intent?.position !== undefined ? note.y : committed.y,
      color: intent?.color !== undefined ? note.color : committed.color,
    };
  });
}

function mergeSpatialAcknowledgement(
  current: Sticky[],
  submitted: Sticky,
  committed: Sticky,
  creating: boolean,
): Sticky[] {
  const preserveLocalChanges = (local: Sticky): Sticky => ({
    ...committed,
    text: local.text !== submitted.text ? local.text : committed.text,
    x: local.x !== submitted.x ? local.x : committed.x,
    y: local.y !== submitted.y ? local.y : committed.y,
    color: local.color !== submitted.color ? local.color : committed.color,
  });
  if (creating) {
    const local = current.find(
      (item) => item.id === submitted.id || item.id === committed.id,
    );
    return [
      ...current.filter(
        (item) => item.id !== submitted.id && item.id !== committed.id,
      ),
      local ? preserveLocalChanges(local) : committed,
    ];
  }
  if (!current.some((item) => item.id === committed.id))
    return [...current, committed];
  return current.map((item) =>
    item.id === committed.id ? preserveLocalChanges(item) : item,
  );
}

function acknowledgeFieldIntent(
  intents: StickyFieldIntents,
  kind: SpatialOperationKind,
  note: Sticky,
) {
  if ((kind === "text" || kind === "create") && intents.text === note.text)
    delete intents.text;
  if (
    (kind === "position" || kind === "create") &&
    intents.position?.x === note.x &&
    intents.position.y === note.y
  )
    delete intents.position;
  if ((kind === "color" || kind === "create") && intents.color === note.color)
    delete intents.color;
}

function hasFieldIntent(intents: StickyFieldIntents): boolean {
  return (
    intents.text !== undefined ||
    intents.position !== undefined ||
    intents.color !== undefined
  );
}
type Tool = "select" | "hand" | "sticky";
type ToolIconName = Tool | "zoom-out" | "zoom-in" | "fit" | "palette";

function ToolIcon({ name }: Readonly<{ name: ToolIconName }>) {
  const paths: Record<ToolIconName, React.ReactNode> = {
    select: <path d="M5 3.5 18.5 12l-6.2 1.2-3.1 6.2L5 3.5Z" />,
    hand: (
      <path d="M8 11V6.5a1 1 0 0 1 2 0V10 5.5a1 1 0 0 1 2 0V10 6.5a1 1 0 0 1 2 0V10 8a1 1 0 0 1 2 0v5c0 4-2.3 7-6.2 7-2.2 0-3.5-1.1-4.8-3l-2-3a1.2 1.2 0 0 1 1.9-1.4L8 15" />
    ),
    sticky: <path d="M4 4h16v11l-5 5H4V4Zm11 16v-5h5" />,
    "zoom-out": <path d="M5 12h14" />,
    "zoom-in": <path d="M5 12h14M12 5v14" />,
    fit: <path d="M9 4H4v5m11-5h5v5m0 6v5h-5M9 20H4v-5" />,
    palette: (
      <path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6h-1a1.5 1.5 0 0 1 0-3H16a5 5 0 0 0 5-5C21 5.8 17 3 12 3Zm-4 6h.01m4-2h.01m4 2h.01m-10 4h.01" />
    ),
  };
  return (
    <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

type ActionIconName = "arrow" | "invite" | "sign-out";
function ActionIcon({ name = "arrow" }: Readonly<{ name?: ActionIconName }>) {
  const path = {
    arrow: <path d="M3 8h9m-3-3 3 3-3 3" />,
    invite: (
      <path d="M6.25 7.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM2.5 13c.25-2.2 1.5-3.4 3.75-3.4S9.75 10.8 10 13M12.5 4.5v5M10 7h5" />
    ),
    "sign-out": <path d="M7 3H3.5v10H7M8.5 8h6M12 5l3 3-3 3" />,
  };
  return (
    <svg className="action-icon" viewBox="0 0 16 16" aria-hidden="true">
      {path[name]}
    </svg>
  );
}
function App() {
  const [mode, setMode] = useState<"login" | "bootstrap" | "invite" | "board">(
    () => (location.pathname === "/bootstrap" ? "bootstrap" : "login"),
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [csrf, setCsrf] = useState("");
  const [boardId, setBoardId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [role, setRole] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "administrator">(
    "member",
  );
  const [deliveryAvailable, setDeliveryAvailable] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [composerInvitationIds, setComposerInvitationIds] = useState<string[]>(
    [],
  );
  const [composerSending, setComposerSending] = useState(false);
  const inviteButton = useRef<HTMLButtonElement>(null);
  const [acceptToken, setAcceptToken] = useState("");
  useEffect(() => {
    const fragmentToken = parseInvitationFragment(location.hash);
    if (!fragmentToken) return;
    setAcceptToken(fragmentToken);
    setMode("invite");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }, []);
  const [sticky, setSticky] = useState<Sticky | null>(null);
  const [stickies, setStickies] = useState<Sticky[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const view = useRef({ zoom, pan });
  view.current = { zoom, pan };
  const [draft, setDraft] = useState("");
  const [colorPickerId, setColorPickerId] = useState<string | null>(null);
  const [colorPickerPosition, setColorPickerPosition] = useState<{
    id: string;
    top: number;
    left: number;
  } | null>(null);
  const [mobileEditor, setMobileEditor] = useState<{
    note: Sticky;
    draft: string;
    pending?: boolean;
    error?: string;
  } | null>(null);
  const dirty = useRef(false);
  const intentionalSocketClose = useRef(false);
  const [status, setStatus] = useState(
    "Sign in or bootstrap a fresh workspace.",
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const autosaves = useRef(new Map<string, number>());
  const dirtyNotes = useRef(new Set<string>());
  const fieldIntents = useRef(new Map<string, StickyFieldIntents>());
  const latestDrafts = useRef(new Map<string, string>());
  const canonicalConflicts = useRef(new Map<string, Sticky>());
  const saveChains = useRef(new Map<string, Promise<Sticky | undefined>>());
  const queuedSaves = useRef(new Map<string, string>());
  const lastSaveErrors = useRef(new Map<string, string>());
  const wheelSamples = useRef<WheelSample[]>([]);
  const wheelGesture = useRef<{ kind: GestureKind; lastAt: number } | null>(
    null,
  );
  const safariGesture = useRef({ active: false, scale: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const fetchRequest = useRef(globalThis.fetch.bind(globalThis));
  const mounted = useRef(true);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const timer of autosaves.current.values())
        window.clearTimeout(timer);
      autosaves.current.clear();
    };
  }, []);
  const drag = useRef<{
    id: string;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  const hand = useRef<{
    clientX: number;
    clientY: number;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    if (!inviteOpen) return;
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>("#invite-panel .composer-back")
        ?.focus(),
    );
    const closeInvite = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setInviteOpen(false);
      requestAnimationFrame(() => inviteButton.current?.focus());
    };
    window.addEventListener("keydown", closeInvite);
    return () => window.removeEventListener("keydown", closeInvite);
  }, [inviteOpen]);
  useEffect(() => {
    if (!inviteOpen && !mobileEditor) return;
    const viewport = window.visualViewport;
    const updateViewport = () => {
      document.documentElement.style.setProperty(
        "--visual-viewport-height",
        `${viewport?.height ?? window.innerHeight}px`,
      );
      document.documentElement.style.setProperty(
        "--visual-viewport-width",
        `${viewport?.width ?? window.innerWidth}px`,
      );
      document.documentElement.style.setProperty(
        "--visual-viewport-top",
        `${viewport?.offsetTop ?? 0}px`,
      );
      document.documentElement.style.setProperty(
        "--visual-viewport-left",
        `${viewport?.offsetLeft ?? 0}px`,
      );
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      document.documentElement.style.removeProperty("--visual-viewport-height");
      document.documentElement.style.removeProperty("--visual-viewport-width");
      document.documentElement.style.removeProperty("--visual-viewport-top");
      document.documentElement.style.removeProperty("--visual-viewport-left");
    };
  }, [inviteOpen, mobileEditor]);
  const spaceHeld = useRef(false);
  const request = async (path: string, init: RequestInit = {}) =>
    fetchRequest.current.call(globalThis, path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...init.headers },
    });
  const load = async (id = boardId) => {
    const r = await request(`/api/boards/${id}`);
    if (r.ok) {
      const body = await r.json();
      const notes: Sticky[] = (
        body.stickies ?? (body.sticky ? [{ ...body.sticky, x: 0, y: 0 }] : [])
      ).map((note: Sticky) => ({ ...note, color: note.color ?? "yellow" }));
      setStickies(notes);
      setSticky(notes[0] ?? null);
      setDraft(notes[0]?.text ?? "");
      if (notes.length === 1)
        setPan({
          x: innerWidth / 2 - notes[0]!.x - 100,
          y: (innerHeight - 60) / 2 - notes[0]!.y - 100,
        });
    }
  };
  useEffect(() => {
    void (async () => {
      const r = await request("/api/session");
      if (r.ok) {
        const body = await r.json();
        setBoardId(body.boardId);
        setTeamId(body.teamId ?? "");
        setRole(body.role ?? "");
        setCsrf(body.csrf ?? "");
        setMembers(body.members ?? []);
        setInvitations((body.invitations ?? []).map(invitationRow));
        setDeliveryAvailable(body.deliveryAvailable === true);
        setMode("board");
        setStatus("Session restored");
        await load(body.boardId);
      }
    })();
  }, []);
  useEffect(() => {
    if (mode !== "board" || !boardId) return;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${protocol}://${location.host}/ws/boards/${boardId}`,
      csrf ? [`commonfield-csrf.${csrf}`] : [],
    );
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === "sticky.committed") {
        setSticky(event.sticky);
        setStickies((current) =>
          mergeCommittedSticky(current, event.sticky, fieldIntents.current),
        );
        if (!dirty.current) setDraft(event.sticky.text);
        setStatus(`Committed version ${event.sticky.version}`);
      }
    };
    ws.onclose = () => {
      if (!intentionalSocketClose.current)
        setStatus("Connection closed; reload to recover.");
    };
    return () => ws.close();
  }, [mode, boardId]);
  const bootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request("/api/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        displayName: name,
        email,
        teamName: team,
        password,
      }),
    });
    setStatus(r.ok ? "Workspace created. Sign in." : (await r.json()).code);
    if (r.ok) setMode("login");
  };
  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) {
      setStatus("Authentication denied");
      return;
    }
    const body = await r.json();
    intentionalSocketClose.current = false;
    const session = await request("/api/session");
    const current = session.ok ? await session.json() : body;
    setCsrf(current.csrf ?? body.csrf);
    setBoardId(current.boardId ?? body.boardId);
    setTeamId(current.teamId ?? body.teamId ?? "");
    setRole(current.role ?? body.role ?? "");
    setMembers(current.members ?? []);
    setInvitations((current.invitations ?? []).map(invitationRow));
    setDeliveryAvailable(current.deliveryAvailable === true);
    setMode("board");
    setStatus("Signed in");
    await load(current.boardId ?? body.boardId);
  };
  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    const response = await request(`/api/teams/${teamId}/invitations`, {
      method: "POST",
      headers: { "x-csrf-token": csrf, origin: location.origin },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    const body = await response.json();
    if (!response.ok) return setStatus(body.code);
    const url =
      body.invitationUrl ?? buildInvitationUrl(location.origin, body.token);
    setInvitations((rows) => [
      ...rows.filter((row) => row.id !== body.invitationId),
      invitationRow({
        invitationId: body.invitationId,
        email: body.email ?? inviteEmail.trim().toLowerCase(),
        role: body.role ?? inviteRole,
        lifecycleStatus: body.lifecycleStatus ?? "pending",
        deliveryStatus: body.deliveryStatus ?? "unsent",
        invitationUrl: url,
      }),
    ]);
    setComposerInvitationIds((ids) =>
      ids.includes(body.invitationId) ? ids : [...ids, body.invitationId],
    );
    setInviteEmail("");
    setInviteRole("member");
    setStatus("Invitation added. The complete link is ready to copy or send.");
  };
  const sendInvitation = async (
    id: string,
    uncertainResendConfirmed = false,
  ) => {
    const response = await request(`/api/invitations/${id}/delivery-attempts`, {
      method: "POST",
      headers: {
        "x-csrf-token": csrf,
        origin: location.origin,
      },
      body: JSON.stringify({ uncertainResendConfirmed }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.code ?? "Delivery request failed");
    setInvitations((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              delivery:
                body.deliveryStatus === "unsent"
                  ? "not_requested"
                  : body.deliveryStatus,
            }
          : row,
      ),
    );
  };
  const sendComposerInvitations = async () => {
    const queued = invitations.filter(
      (row) =>
        composerInvitationIds.includes(row.id) &&
        row.lifecycle === "pending" &&
        (row.delivery === "not_requested" || row.delivery === "failed"),
    );
    if (!queued.length || !deliveryAvailable) return;
    setComposerSending(true);
    try {
      for (const row of queued) await sendInvitation(row.id);
      setStatus("Eligible invitations sent.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Delivery request failed",
      );
    } finally {
      setComposerSending(false);
    }
  };
  const logout = async () => {
    intentionalSocketClose.current = true;
    const response = await request("/api/logout", {
      method: "POST",
      headers: { "x-csrf-token": csrf, origin: location.origin },
      body: "{}",
    });
    if (!response.ok) {
      intentionalSocketClose.current = false;
      return setStatus((await response.json()).code);
    }
    setCsrf("");
    setMode("login");
    setStatus("Signed out");
  };
  const acceptInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    const response = await request("/api/invitations/accept", {
      method: "POST",
      body: JSON.stringify({
        token: acceptToken,
        email,
        displayName: name,
        password,
      }),
    });
    const body = await response.json();
    if (!response.ok) return setStatus(body.code);
    setAcceptToken("");
    const session = await request("/api/session");
    const current = await session.json();
    setCsrf(current.csrf ?? body.csrf);
    setBoardId(current.boardId);
    setTeamId(current.teamId);
    setRole(current.role);
    setMembers(current.members ?? []);
    setInvitations((current.invitations ?? []).map(invitationRow));
    setDeliveryAvailable(current.deliveryAvailable === true);
    setMode("board");
    setStatus("Invitation accepted");
    await load(current.boardId);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await request(`/api/boards/${boardId}/sticky`, {
      method: "PUT",
      headers: { "x-csrf-token": csrf, origin: location.origin },
      body: JSON.stringify({
        operationId: crypto.randomUUID(),
        text: draft,
        expectedVersion: sticky?.version ?? 0,
      }),
    });
    const body = await r.json();
    if (r.ok) {
      dirty.current = false;
      setSticky(body);
      setStatus(`Saved version ${body.version}`);
    } else if (body.code === "version_conflict") {
      setSticky(body.canonical);
      setStatus("Conflict: your draft is preserved.");
      input.current?.focus();
    } else setStatus(body.code);
  };
  const handleSpatialFailure = (
    note: Sticky,
    body: { code?: string; canonical?: Sticky },
  ): Sticky | undefined => {
    lastSaveErrors.current.set(note.id, body.code ?? "save_failed");
    if (body.code === "version_conflict" && body.canonical) {
      canonicalConflicts.current.set(note.id, body.canonical);
      setStickies((current) =>
        current.map((item) =>
          item.id === note.id
            ? {
                ...body.canonical!,
                text: item.text,
                version: body.canonical!.version,
              }
            : item,
        ),
      );
    }
    setStatus(
      body.code === "version_conflict"
        ? "Conflict: your draft is preserved."
        : (body.code ?? "save_failed"),
    );
    return body.canonical;
  };
  const reconcileSpatialSuccess = (
    note: Sticky,
    body: Sticky,
    creating: boolean,
    operationKind: SpatialOperationKind,
  ) => {
    if (latestDrafts.current.get(note.id) === note.text) {
      dirtyNotes.current.delete(note.id);
      dirty.current = dirtyNotes.current.size > 0;
    }
    canonicalConflicts.current.delete(note.id);
    setStickies((current) =>
      mergeSpatialAcknowledgement(current, note, body, creating),
    );
    const intents = fieldIntents.current.get(note.id);
    if (intents) {
      acknowledgeFieldIntent(intents, operationKind, note);
      if (!hasFieldIntent(intents)) fieldIntents.current.delete(note.id);
    }
    if (creating && body.id !== note.id) {
      const text = latestDrafts.current.get(note.id);
      if (text !== undefined) {
        latestDrafts.current.delete(note.id);
        latestDrafts.current.set(body.id, text);
      }
      if (dirtyNotes.current.delete(note.id)) dirtyNotes.current.add(body.id);
      const creatingIntents = fieldIntents.current.get(note.id);
      if (creatingIntents) {
        fieldIntents.current.delete(note.id);
        fieldIntents.current.set(body.id, creatingIntents);
      }
      setSelectedNoteId((id) => (id === note.id ? body.id : id));
      setMobileEditor((editor) =>
        editor?.note.id === note.id
          ? { ...editor, note: { ...editor.note, id: body.id } }
          : editor,
      );
    }
    setSticky(body);
    setStatus(`Saved version ${body.version}`);
  };
  const commitSpatial = async (
    note: Sticky,
    creating = false,
    operationKind: SpatialOperationKind = creating ? "create" : "text",
  ): Promise<Sticky | undefined> => {
    lastSaveErrors.current.delete(note.id);
    let response: Response;
    try {
      response = await request(
        creating
          ? `/api/boards/${boardId}/stickies`
          : `/api/boards/${boardId}/stickies/${note.id}`,
        {
          method: creating ? "POST" : "PATCH",
          headers: { "x-csrf-token": csrf, origin: location.origin },
          body: JSON.stringify({
            operationId: crypto.randomUUID(),
            operationKind,
            text: note.text,
            x: note.x,
            y: note.y,
            color: note.color,
            expectedVersion: creating ? 0 : note.version,
          }),
        },
      );
    } catch {
      lastSaveErrors.current.set(note.id, "network_error");
      setStatus("Save failed. Your draft is preserved.");
      return undefined;
    }
    const body = (await response.json()) as Sticky & {
      code?: string;
      canonical?: Sticky;
    };
    if (!response.ok) return handleSpatialFailure(note, body);
    reconcileSpatialSuccess(note, body, creating, operationKind);
    return body;
  };
  const enqueueSpatial = (
    note: Sticky,
    creating = false,
    operationKind: SpatialOperationKind = creating ? "create" : "text",
  ) => {
    const intents = fieldIntents.current.get(note.id) ?? {};
    if (operationKind === "text" || operationKind === "create")
      intents.text = note.text;
    if (operationKind === "position" || operationKind === "create")
      intents.position = { x: note.x, y: note.y };
    if (operationKind === "color" || operationKind === "create")
      intents.color = note.color;
    fieldIntents.current.set(note.id, intents);
    const fingerprint = `${operationKind}\u0000${note.version}\u0000${note.text}\u0000${note.x}\u0000${note.y}\u0000${note.color}`;
    if (queuedSaves.current.get(note.id) === fingerprint) return;
    queuedSaves.current.set(note.id, fingerprint);
    const previous =
      saveChains.current.get(note.id) ?? Promise.resolve(undefined);
    const next = previous
      .catch(() => undefined)
      .then((acknowledged) => {
        if (!mounted.current) return undefined;
        const effectiveCreating = creating && !acknowledged;
        return commitSpatial(
          acknowledged
            ? {
                ...note,
                id: acknowledged.id,
                version: acknowledged.version,
              }
            : note,
          effectiveCreating,
          !effectiveCreating && operationKind === "create"
            ? "text"
            : operationKind,
        );
      })
      .finally(() => {
        if (queuedSaves.current.get(note.id) === fingerprint)
          queuedSaves.current.delete(note.id);
        if (saveChains.current.get(note.id) === next)
          saveChains.current.delete(note.id);
      });
    saveChains.current.set(note.id, next);
  };
  const placeSticky = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== "sticky") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pointerX = stickies.length
      ? event.clientX - rect.left
      : rect.width / 2;
    const pointerY = stickies.length
      ? event.clientY - rect.top
      : rect.height / 2;
    const note: Sticky = {
      id: crypto.randomUUID(),
      text: "",
      x: Math.round(((pointerX - pan.x) / zoom - 100) * 4) / 4,
      y: Math.round(((pointerY - pan.y) / zoom - 100) * 4) / 4,
      version: 0,
      color: "yellow",
    };
    setStickies((current) => [...current, note]);
    setSticky(note);
    setDraft(note.text);
    setTool("select");
  };
  const updateNote = (id: string, changes: Partial<Sticky>) =>
    setStickies((current) =>
      current.map((note) => (note.id === id ? { ...note, ...changes } : note)),
    );
  const positionColorPicker = (id: string, frame: HTMLElement) => {
    const rect = frame.getBoundingClientRect();
    const isNarrowViewport = innerWidth <= 599;
    const paletteHalfWidth = isNarrowViewport
      ? Math.min(94, Math.max(49, innerWidth / 2 - 12))
      : Math.min(203, Math.max(49, innerWidth / 2 - 12));
    const paletteHeight = isNarrowViewport ? 132 : 76;
    const triggerHeight = 44;
    const toolbarGap = 12;
    const topEdge = 12;
    setColorPickerPosition({
      id,
      top:
        rect.top >= paletteHeight + triggerHeight + toolbarGap + topEdge
          ? rect.top - triggerHeight - toolbarGap
          : Math.min(
              rect.bottom + toolbarGap,
              innerHeight - triggerHeight - topEdge,
            ),
      left: Math.min(
        Math.max(rect.left + rect.width / 2, paletteHalfWidth + 12),
        innerWidth - paletteHalfWidth - 12,
      ),
    });
  };
  useEffect(() => {
    if (!selectedNoteId) return;
    const updatePosition = () => {
      const frame = document.getElementById(`note-${selectedNoteId}`);
      if (frame) positionColorPicker(selectedNoteId, frame);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [selectedNoteId, pan, zoom]);
  const dragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (hand.current) {
      setPan({
        x: hand.current.x + event.clientX - hand.current.clientX,
        y: hand.current.y + event.clientY - hand.current.clientY,
      });
      return;
    }
    if (!drag.current) return;
    updateNote(drag.current.id, {
      x: drag.current.x + (event.clientX - drag.current.clientX) / zoom,
      y: drag.current.y + (event.clientY - drag.current.clientY) / zoom,
    });
  };
  const dragEnd = () => {
    hand.current = null;
    if (!drag.current) return;
    const note = stickies.find((item) => item.id === drag.current?.id);
    drag.current = null;
    if (note) enqueueSpatial(note, false, "position");
  };
  useEffect(() => {
    if (mode !== "board") return;
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key.toLowerCase() === "v") setTool("select");
      if (event.key.toLowerCase() === "h") setTool("hand");
      if (event.key.toLowerCase() === "n") setTool("sticky");
      if (event.code === "Space") spaceHeld.current = true;
      if (event.key === "Enter" && tool === "sticky") {
        const rect = document
          .querySelector<HTMLElement>(".canvas")
          ?.getBoundingClientRect();
        const note: Sticky = {
          id: crypto.randomUUID(),
          text: "",
          x:
            Math.round(
              ((-pan.x + (rect?.width ?? innerWidth) / 2) / zoom - 100) * 4,
            ) / 4,
          y:
            Math.round(
              ((-pan.y + (rect?.height ?? innerHeight) / 2) / zoom - 100) * 4,
            ) / 4,
          version: 0,
          color: "yellow",
        };
        setStickies((current) => [...current, note]);
        setSticky(note);
        setTool("select");
      }
    };
    window.addEventListener("keydown", shortcut);
    const release = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeld.current = false;
    };
    window.addEventListener("keyup", release);
    return () => {
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("keyup", release);
    };
  }, [mode, tool, pan, zoom]);
  const discardDraft = (event: React.MouseEvent<HTMLButtonElement>) => {
    const stickyId = event.currentTarget.dataset.stickyId;
    setStickies((current) => current.filter((item) => item.id !== stickyId));
  };
  const reconcileDraft = (event: React.MouseEvent<HTMLButtonElement>) => {
    const stickyId = event.currentTarget.dataset.stickyId!;
    const canonical = canonicalConflicts.current.get(stickyId);
    if (canonical)
      setStatus(
        `Authoritative version ${canonical.version}; local draft preserved.`,
      );
  };
  const retryDraft = (event: React.MouseEvent<HTMLButtonElement>) => {
    const stickyId = event.currentTarget.dataset.stickyId!;
    const canonical = canonicalConflicts.current.get(stickyId);
    const local = stickies.find((item) => item.id === stickyId);
    if (canonical && local)
      enqueueSpatial({ ...local, version: canonical.version }, false, "text");
  };
  const discardConflictedDraft = (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    const stickyId = event.currentTarget.dataset.stickyId!;
    const canonical = canonicalConflicts.current.get(stickyId);
    if (!canonical) return;
    canonicalConflicts.current.delete(stickyId);
    dirtyNotes.current.delete(stickyId);
    latestDrafts.current.delete(stickyId);
    setStickies((current) =>
      current.map((item) => (item.id === stickyId ? canonical : item)),
    );
    setStatus(`Restored committed version ${canonical.version}`);
  };
  const composerInvitations = invitations.filter((row) =>
    composerInvitationIds.includes(row.id),
  );
  const ownScreenOpen =
    window.innerWidth <= 599 && (mobileEditor !== null || inviteOpen);
  const trapOwnScreenFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || mode !== "board") return;
    const zoomAt = (clientX: number, clientY: number, scale: number) => {
      const rect = canvas.getBoundingClientRect();
      const pointerX = clientX - rect.left;
      const pointerY = clientY - rect.top;
      const { zoom: currentZoom, pan: currentPan } = view.current;
      const nextZoom = Math.min(4, Math.max(0.1, currentZoom * scale));
      const worldX = (pointerX - currentPan.x) / currentZoom;
      const worldY = (pointerY - currentPan.y) / currentZoom;
      const nextPan = {
        x: pointerX - worldX * nextZoom,
        y: pointerY - worldY * nextZoom,
      };
      view.current = { zoom: nextZoom, pan: nextPan };
      setPan(nextPan);
      setZoom(nextZoom);
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey && safariGesture.current.active) return;
      const at = event.timeStamp;
      const continuation = continueWheelGesture(wheelGesture.current, at);
      if (continuation.fresh) wheelSamples.current = [];
      wheelSamples.current.push({
        at,
        ctrlKey: event.ctrlKey,
        deltaMode: event.deltaMode,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
      });
      wheelSamples.current = wheelSamples.current.slice(-3);
      const kind = event.ctrlKey
        ? "zoom"
        : (continuation.kind ?? classifyWheelGesture(wheelSamples.current));
      if (!kind) return;
      wheelGesture.current = { kind, lastAt: at };
      if (kind === "pan")
        setPan((current) => ({
          x: current.x - event.deltaX,
          y: current.y - event.deltaY,
        }));
      else
        zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * 0.001));
    };
    const gestureStart = (event: Event) => {
      event.preventDefault();
      safariGesture.current = { active: true, scale: 1 };
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & {
        scale?: number;
        clientX?: number;
        clientY?: number;
      };
      const nextScale = gesture.scale ?? 1;
      if (!Number.isFinite(nextScale) || nextScale <= 0) return;
      if (!safariGesture.current.active) return;
      const previousScale = safariGesture.current.scale;
      zoomAt(
        gesture.clientX ?? canvas.clientWidth / 2,
        gesture.clientY ?? canvas.clientHeight / 2,
        nextScale / previousScale,
      );
      safariGesture.current.scale = nextScale;
    };
    const gestureEnd = (event: Event) => {
      event.preventDefault();
      safariGesture.current = { active: false, scale: 1 };
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("gesturestart", gestureStart, { passive: false });
    canvas.addEventListener("gesturechange", gestureChange, { passive: false });
    canvas.addEventListener("gestureend", gestureEnd, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("gesturestart", gestureStart);
      canvas.removeEventListener("gesturechange", gestureChange);
      canvas.removeEventListener("gestureend", gestureEnd);
    };
  }, [mode]);
  return (
    <main className={`app-shell mode-${mode}`}>
      {mode !== "board" && (
        <section className="auth-shell">
          <div className="auth-card">
            <header className="auth-brand">
              <span className="auth-brand-marker" aria-hidden="true" />
              <h1 className="auth-brand-title">Team board</h1>
            </header>
            <nav className="entry-nav" aria-label="Entry choices">
              <button data-testid="show-login" onClick={() => setMode("login")}>
                <ActionIcon /> Sign in
              </button>
              <button
                data-testid="show-bootstrap"
                onClick={() => setMode("bootstrap")}
              >
                <ActionIcon /> Bootstrap
              </button>
              <button
                data-testid="show-invite"
                onClick={() => setMode("invite")}
              >
                <ActionIcon /> Accept invitation
              </button>
            </nav>
            <p className="auth-status sr-only" role="status" aria-live="polite">
              {status}
            </p>
            {mode === "bootstrap" && (
              <form className="auth-form bootstrap-form" onSubmit={bootstrap}>
                <span className="auth-badge">One-time setup</span>
                <h2>Set up the first administrator</h2>
                <p>
                  Create the first administrator account and team for this
                  server. Only the server operator should do this.
                </p>
                <label>
                  <span>Display name</span>
                  <input
                    data-testid="display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Email address</span>
                  <input
                    data-testid="bootstrap-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Team name</span>
                  <input
                    data-testid="team-name"
                    value={team}
                    onChange={(e) => setTeam(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    data-testid="bootstrap-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={12}
                    required
                  />
                  <small>
                    12–128 characters. Stored only as a secure hash.
                  </small>
                </label>
                <p className="auth-notice">
                  ⓘ This page works once. After the first administrator is
                  created it is permanently disabled. Everyone else joins by
                  invitation — there is no public sign-up.
                </p>
                <button data-testid="bootstrap-submit">
                  Create administrator and team
                </button>
              </form>
            )}
            {mode === "login" && (
              <form className="auth-form login-form" onSubmit={login}>
                <p>Sign in to work on your board together.</p>
                <label className="auth-email-field">
                  <span>Email address</span>
                  <svg
                    className="auth-email-icon"
                    viewBox="0 0 18 18"
                    aria-hidden="true"
                  >
                    <rect x="2.5" y="4" width="13" height="10" rx="2" />
                    <path d="m3.5 5.5 5.5 4 5.5-4" />
                  </svg>
                  <input
                    className="auth-email-input"
                    data-testid="email"
                    type="email"
                    placeholder="name@team.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    data-testid="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <button data-testid="login-submit">Sign in</button>
              </form>
            )}
            {mode === "invite" && (
              <form
                className="auth-form invitation-flow"
                onSubmit={acceptInvitation}
              >
                <h2>Accept an invitation</h2>
                <output>
                  Review the invitation and matching account before explicitly
                  accepting.
                </output>
                <ol
                  className="invitation-steps"
                  aria-label="Invitation progress"
                >
                  <li aria-current="step">Review invitation</li>
                  <li>Account</li>
                  <li>Join team</li>
                </ol>
                <label>
                  <span>Email</span>
                  <input
                    data-testid="accept-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Display name</span>
                  <input
                    data-testid="accept-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    data-testid="accept-password"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={12}
                    required
                  />
                </label>
                <button data-testid="accept-submit">
                  Create account and join
                </button>
              </form>
            )}
          </div>
        </section>
      )}
      {mode === "board" && (
        <section
          className={`board-shell${ownScreenOpen ? " has-own-screen" : ""}`}
          aria-labelledby="board-title"
        >
          <output className="sr-only" aria-live="polite">
            {status}
          </output>
          <h2 id="board-title" className="board-title-pill">
            <span className="board-title-marker" aria-hidden="true" />
            {" Team board"}
          </h2>
          <p className="sr-only">
            Committed version:{" "}
            <output data-testid="version">{sticky?.version ?? 0}</output>
          </p>
          <div
            className="board-toolbar floating-palette"
            inert={ownScreenOpen}
            role="toolbar"
            aria-label="Board tools"
          >
            <button
              type="button"
              title="Select notes (V)"
              aria-pressed={tool === "select"}
              onClick={() => setTool("select")}
            >
              <ToolIcon name="select" />
              <span className="tool-label">Select</span>
              <kbd>V</kbd>
            </button>
            <button
              type="button"
              title="Hand or Space pan (H)"
              aria-pressed={tool === "hand"}
              onClick={() => setTool("hand")}
            >
              <ToolIcon name="hand" />
              <span className="tool-label">Hand</span>
              <kbd>H</kbd>
            </button>
            <button
              type="button"
              aria-pressed={tool === "sticky"}
              onClick={() => setTool("sticky")}
            >
              <ToolIcon name="sticky" />
              <span className="tool-label">Sticky</span>
              <kbd>N</kbd>
            </button>
          </div>
          <p className="navigation-help sr-only" id="canvas-navigation-help">
            Wheel and trackpad gestures are detected automatically. Arrow keys
            pan the canvas.
          </p>
          <div
            ref={canvasRef}
            inert={ownScreenOpen}
            className={`canvas tool-${tool}`}
            data-testid="canvas"
            tabIndex={0}
            role="application"
            aria-label="Spatial board"
            aria-describedby="canvas-navigation-help"
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              const movement: Record<string, [number, number]> = {
                ArrowLeft: [40, 0],
                ArrowRight: [-40, 0],
                ArrowUp: [0, 40],
                ArrowDown: [0, -40],
              };
              const delta = movement[event.key];
              if (!delta) return;
              event.preventDefault();
              setPan((current) => {
                const next = sanitizeView(
                  { x: current.x + delta[0], y: current.y + delta[1], zoom },
                  zoom,
                );
                return { x: next.x, y: next.y };
              });
            }}
            onPointerDown={(event) => {
              const frame = (event.target as HTMLElement).closest<HTMLElement>(
                ".sticky-frame",
              );
              const note = frame
                ? stickies.find((item) => item.id === frame.dataset.noteId)
                : undefined;
              if (frame && note) {
                setSelectedNoteId(note.id);
                setSticky(note);
                positionColorPicker(note.id, frame);
              } else {
                placeSticky(event);
              }
              if (tool === "hand" || spaceHeld.current)
                hand.current = {
                  clientX: event.clientX,
                  clientY: event.clientY,
                  x: pan.x,
                  y: pan.y,
                };
            }}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
          >
            <div
              className="canvas-world"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              {sortNotesForKeyboard(stickies).map((note) => (
                <article
                  key={note.id}
                  id={`note-${note.id}`}
                  data-note-id={note.id}
                  aria-label={`Sticky ${note.text.slice(0, 30) || "draft"}`}
                  aria-current={selectedNoteId === note.id ? "true" : undefined}
                  className={`sticky-frame sticky-${note.color}`}
                  style={{ transform: `translate(${note.x}px, ${note.y}px)` }}
                >
                  <button
                    type="button"
                    className="sticky-drag"
                    aria-label={`Move sticky ${note.text.slice(0, 30)}`}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      drag.current = {
                        id: note.id,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        x: note.x,
                        y: note.y,
                      };
                    }}
                    onKeyDown={(event) => {
                      const step = event.shiftKey ? 1 : 10;
                      const movement: Record<string, [number, number]> = {
                        ArrowLeft: [-step, 0],
                        ArrowRight: [step, 0],
                        ArrowUp: [0, -step],
                        ArrowDown: [0, step],
                      };
                      const delta = movement[event.key];
                      if (!delta) return;
                      event.preventDefault();
                      const moved = {
                        ...note,
                        x: note.x + delta[0]!,
                        y: note.y + delta[1]!,
                      };
                      updateNote(note.id, moved);
                      if (note.version > 0)
                        enqueueSpatial(moved, false, "position");
                    }}
                  >
                    <span aria-hidden="true">⋮⋮</span>
                  </button>
                  <textarea
                    autoFocus={note.version === 0}
                    ref={(element) => {
                      if (element && note.version === 0)
                        window.setTimeout(() => element.focus(), 0);
                    }}
                    aria-label={`Sticky note ${note.text.slice(0, 30)}`}
                    className="spatial-sticky"
                    value={note.text}
                    onFocus={(event) => {
                      setSelectedNoteId(note.id);
                      setSticky(note);
                      setDraft(note.text);
                      const frame =
                        event.currentTarget.closest<HTMLElement>(
                          ".sticky-frame",
                        );
                      if (frame) positionColorPicker(note.id, frame);
                      if (window.innerWidth <= 599)
                        setMobileEditor({ note, draft: note.text });
                    }}
                    onChange={(event) => {
                      const text = event.target.value;
                      dirty.current = true;
                      dirtyNotes.current.add(note.id);
                      fieldIntents.current.set(note.id, {
                        ...fieldIntents.current.get(note.id),
                        text,
                      });
                      latestDrafts.current.set(note.id, text);
                      updateNote(note.id, { text });
                      setDraft(text);
                      window.clearTimeout(autosaves.current.get(note.id));
                      if (text.trim())
                        autosaves.current.set(
                          note.id,
                          window.setTimeout(
                            () =>
                              enqueueSpatial(
                                { ...note, text },
                                note.version === 0,
                              ),
                            500,
                          ),
                        );
                    }}
                    onBlur={(event) => {
                      if (window.innerWidth <= 599) return;
                      window.clearTimeout(autosaves.current.get(note.id));
                      autosaves.current.delete(note.id);
                      const changed = {
                        ...note,
                        text: event.currentTarget.value,
                      };
                      if (
                        dirtyNotes.current.has(note.id) &&
                        changed.text.trim()
                      )
                        enqueueSpatial(changed, note.version === 0);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  {selectedNoteId === note.id &&
                    !ownScreenOpen &&
                    createPortal(
                      <div
                        className="color-picker"
                        style={
                          colorPickerPosition?.id === note.id
                            ? {
                                position: "fixed",
                                top: colorPickerPosition.top,
                                bottom: "auto",
                                left: colorPickerPosition.left,
                              }
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className="color-trigger"
                          aria-label="Choose sticky color"
                          title="Choose sticky color"
                          aria-expanded={colorPickerId === note.id}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setColorPickerId(null);
                              event.currentTarget.focus();
                            }
                          }}
                          onClick={() => {
                            const frame = document.getElementById(
                              `note-${note.id}`,
                            );
                            if (frame) positionColorPicker(note.id, frame);
                            setColorPickerId((id) =>
                              id === note.id ? null : note.id,
                            );
                          }}
                        >
                          <span
                            className={`current-colour swatch-${note.color}`}
                            aria-hidden="true"
                          />
                          <span>Colour</span>
                        </button>
                        {colorPickerId === note.id && (
                          <fieldset
                            className="color-palette"
                            aria-label="Sticky color"
                          >
                            <legend>Note colour</legend>
                            {STICKY_COLORS.map((choice) => (
                              <button
                                key={choice.name}
                                type="button"
                                className={`color-swatch swatch-${choice.name}`}
                                aria-label={`${choice.label} sticky color`}
                                aria-pressed={note.color === choice.name}
                                title={choice.label}
                                onKeyDown={(event) => {
                                  if (event.key !== "Escape") return;
                                  setColorPickerId(null);
                                  event.currentTarget
                                    .closest(".color-picker")
                                    ?.querySelector<HTMLButtonElement>(
                                      ".color-trigger",
                                    )
                                    ?.focus();
                                }}
                                onClick={() => {
                                  const changed = {
                                    ...note,
                                    color: choice.name,
                                  };
                                  updateNote(note.id, changed);
                                  if (note.version > 0)
                                    enqueueSpatial(changed, false, "color");
                                }}
                              >
                                <span>{choice.label.toLowerCase()}</span>
                              </button>
                            ))}
                          </fieldset>
                        )}
                      </div>,
                      document.body,
                    )}
                  {note.version === 0 && (
                    <button
                      type="button"
                      className="discard-draft"
                      data-sticky-id={note.id}
                      onClick={discardDraft}
                    >
                      <ActionIcon /> Discard draft
                    </button>
                  )}
                  {canonicalConflicts.current.has(note.id) && (
                    <div className="conflict-actions">
                      <button
                        type="button"
                        data-sticky-id={note.id}
                        onClick={reconcileDraft}
                      >
                        <ActionIcon /> Reconcile
                      </button>
                      <button
                        type="button"
                        data-sticky-id={note.id}
                        onClick={retryDraft}
                      >
                        <ActionIcon /> Retry local draft
                      </button>
                      <button
                        type="button"
                        data-sticky-id={note.id}
                        onClick={discardConflictedDraft}
                      >
                        <ActionIcon /> Discard draft
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
          {mobileEditor && (
            <dialog
              open
              className={`mobile-sticky-editor sticky-${mobileEditor.note.color}`}
              aria-label="Mobile sticky editor"
              aria-modal="true"
              onKeyDown={trapOwnScreenFocus}
            >
              <textarea
                autoFocus
                aria-label="Edit sticky note"
                value={mobileEditor.draft}
                readOnly={Boolean(mobileEditor.pending)}
                onChange={(event) =>
                  setMobileEditor((current) =>
                    current && !current.pending
                      ? { ...current, draft: event.target.value }
                      : current,
                  )
                }
              />
              {mobileEditor.error && (
                <p className="mobile-editor-error" role="alert">
                  {mobileEditor.error}
                </p>
              )}
              <div className="mobile-sticky-actions">
                <button
                  className="mobile-discard discard-mobile-draft"
                  type="button"
                  aria-label="Discard mobile draft"
                  disabled={mobileEditor.pending}
                  onClick={() => {
                    if (mobileEditor.note.version === 0)
                      setStickies((current) =>
                        current.filter(
                          (note) => note.id !== mobileEditor.note.id,
                        ),
                      );
                    setMobileEditor(null);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
                <button
                  className="mobile-commit commit-mobile-draft"
                  type="button"
                  aria-label="Commit mobile draft"
                  disabled={mobileEditor.pending}
                  onClick={() => {
                    const changed = {
                      ...mobileEditor.note,
                      text: mobileEditor.draft,
                    };
                    setMobileEditor((current) =>
                      current
                        ? {
                            note: current.note,
                            draft: current.draft,
                            pending: true,
                          }
                        : current,
                    );
                    void commitSpatial(
                      changed,
                      changed.version === 0,
                      changed.version === 0 ? "create" : "text",
                    ).then((saved) => {
                      const error = lastSaveErrors.current.get(changed.id);
                      if (saved && !canonicalConflicts.current.has(changed.id))
                        setMobileEditor(null);
                      else
                        setMobileEditor((current) =>
                          current
                            ? {
                                ...current,
                                pending: false,
                                error:
                                  error ??
                                  (canonicalConflicts.current.has(changed.id)
                                    ? "version_conflict"
                                    : "save_failed"),
                                note: {
                                  ...current.note,
                                  version:
                                    canonicalConflicts.current.get(changed.id)
                                      ?.version ?? current.note.version,
                                },
                              }
                            : current,
                        );
                    });
                  }}
                >
                  <span aria-hidden="true">✓</span>
                </button>
              </div>
            </dialog>
          )}
          <fieldset
            className="zoom-controls canvas-navigation"
            inert={ownScreenOpen}
            aria-label="Canvas navigation"
          >
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => setZoom((value) => Math.max(0.1, value - 0.1))}
            >
              <ToolIcon name="zoom-out" />
            </button>
            <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => setZoom((value) => Math.min(4, value + 0.1))}
            >
              <ToolIcon name="zoom-in" />
            </button>
            <span className="zoom-divider" aria-hidden="true" />
            <button
              type="button"
              aria-label="Fit to content"
              onClick={() => {
                if (!stickies.length) {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                  return;
                }
                const minX = Math.min(...stickies.map((note) => note.x));
                const maxX = Math.max(...stickies.map((note) => note.x + 200));
                const minY = Math.min(...stickies.map((note) => note.y));
                const maxY = Math.max(...stickies.map((note) => note.y + 200));
                const next = Math.min(
                  2,
                  Math.max(
                    0.1,
                    Math.min(
                      (innerWidth - 160) / (maxX - minX),
                      (innerHeight - 120) / (maxY - minY),
                    ),
                  ),
                );
                setZoom(next);
                setPan({ x: 80 - minX * next, y: 60 - minY * next });
              }}
            >
              <ToolIcon name="fit" />
              <span>Fit</span>
            </button>
          </fieldset>
          <form
            className="legacy-sticky-form"
            inert={ownScreenOpen}
            onSubmit={save}
          >
            <label htmlFor="sticky">Sticky text</label>
            <textarea
              id="sticky"
              data-testid="sticky-text"
              ref={input}
              value={draft}
              onChange={(e) => {
                dirty.current = true;
                setDraft(e.target.value);
              }}
              maxLength={2000}
            />
            <button data-testid="save-sticky">
              <ActionIcon />
              {sticky ? "Update sticky" : "Create first sticky"}
            </button>
          </form>
          {role === "administrator" && (
            <>
              <button
                ref={inviteButton}
                inert={ownScreenOpen}
                type="button"
                className="invite-toggle"
                aria-label="Invite a member"
                title="Invite a member"
                aria-expanded={inviteOpen}
                aria-controls="invite-panel"
                onClick={() => setInviteOpen((open) => !open)}
              >
                <ActionIcon name="invite" /> Invite
              </button>
              {inviteOpen && (
                <dialog
                  id="invite-panel"
                  open
                  aria-modal="true"
                  aria-labelledby="invite-panel-title"
                  onKeyDown={trapOwnScreenFocus}
                >
                  <form
                    className="invitation-composer-form"
                    aria-label="Add invitation recipient"
                    onSubmit={invite}
                  >
                    <header className="composer-header">
                      <button
                        type="button"
                        className="composer-back composer-secondary"
                        aria-label="Back to board"
                        onClick={() => {
                          setInviteOpen(false);
                          requestAnimationFrame(() =>
                            inviteButton.current?.focus(),
                          );
                        }}
                      >
                        <span aria-hidden="true">←</span>
                      </button>
                      <h3 id="invite-panel-title">Invite to Team board</h3>
                    </header>
                    <p>Add recipients, then send eligible invitations.</p>
                    <div className="composer-controls">
                      <label>
                        <span>Email</span>
                        <input
                          data-testid="invite-email"
                          type="email"
                          placeholder="name@example.com"
                          value={inviteEmail}
                          onChange={(event) =>
                            setInviteEmail(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            if (
                              !invitationAddIntent({
                                key: event.key,
                                field: "email",
                                composing: event.nativeEvent.isComposing,
                              })
                            ) {
                              event.preventDefault();
                              return;
                            }
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }}
                          required
                        />
                      </label>
                      <label>
                        <span>Role</span>
                        <select
                          data-testid="invite-role"
                          value={inviteRole}
                          onChange={(event) =>
                            setInviteRole(
                              event.target.value as "member" | "administrator",
                            )
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                          }}
                        >
                          <option value="member">Member</option>
                          <option value="administrator">Administrator</option>
                        </select>
                      </label>
                      <button
                        className="composer-add composer-secondary"
                        data-testid="invite-submit"
                      >
                        Add
                      </button>
                    </div>
                    <p className="composer-count">
                      Recipients · {composerInvitations.length}
                    </p>
                    <div className="composer-recipients">
                      {composerInvitations.map((row) => (
                        <article className="composer-recipient" key={row.id}>
                          <span>{row.email}</span>
                          <strong>{invitationLabel(row.role)}</strong>
                          <input
                            className="composer-url"
                            readOnly
                            aria-label={`Invitation link for ${row.email}`}
                            data-sensitive="invitation-url"
                            value={row.url}
                          />
                          <button
                            type="button"
                            className="composer-secondary"
                            onClick={() =>
                              void navigator.clipboard.writeText(row.url)
                            }
                          >
                            Copy
                          </button>
                          <small>
                            {invitationLabel(row.delivery)} ·{" "}
                            {invitationLabel(row.lifecycle)}
                          </small>
                        </article>
                      ))}
                    </div>
                    <p className="composer-transport-hint">
                      {
                        "Sends Unsent or Failed only. Sent means mail-server accepted, not inbox delivery."
                      }
                    </p>
                    <button
                      type="button"
                      className="composer-send"
                      disabled={
                        composerSending ||
                        !deliveryAvailable ||
                        composerInvitationIds.length === 0
                      }
                      onClick={() => void sendComposerInvitations()}
                    >
                      {composerSending ? "Sending…" : "Send invitation"}
                    </button>
                    <p className="composer-enter-hint">
                      {
                        "Enter in Email adds only. Successful Add clears Email and resets Member."
                      }
                    </p>
                    <button
                      type="button"
                      className="composer-management-access composer-secondary"
                      onClick={() => {
                        setInviteOpen(false);
                        setManagementOpen(true);
                      }}
                    >
                      Manage members and invitations
                    </button>
                  </form>
                </dialog>
              )}
              <section
                className={`team-management${managementOpen ? " is-open" : ""}`}
                aria-label="Team management"
                inert={ownScreenOpen}
              >
                <header>
                  <div>
                    <span>← Your boards</span>
                    <h2>Team members and invitations</h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setManagementOpen(false)}
                  >
                    Close
                  </button>
                </header>
                <TeamAccessPanel
                  members={members}
                  invitations={invitations}
                  deliveryAvailable={deliveryAvailable}
                  deliveryUnavailableReason="Local invitation delivery is unavailable"
                  onCopy={(url) => void navigator.clipboard.writeText(url)}
                  onSend={sendInvitation}
                  onRevoke={async (id) => {
                    const response = await request(
                      `/api/invitations/${id}/revoke`,
                      {
                        method: "POST",
                        headers: {
                          "x-csrf-token": csrf,
                          origin: location.origin,
                        },
                        body: "{}",
                      },
                    );
                    if (!response.ok) {
                      const body = await response.json();
                      throw new Error(body.code ?? "Revoke request failed");
                    }
                    setInvitations((rows) =>
                      rows.filter((row) => row.id !== id),
                    );
                  }}
                />
              </section>
            </>
          )}
          <button data-testid="logout" inert={ownScreenOpen} onClick={logout}>
            <ActionIcon name="sign-out" /> Sign out
          </button>
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
