import React, { useState } from "react";

export type MemberRow = {
  id: string;
  email: string;
  role: "member" | "administrator";
};
export type InvitationRow = MemberRow & {
  lifecycle: "pending" | "accepted" | "revoked" | "expired";
  delivery: "not_requested" | "queued" | "sent" | "failed" | "uncertain";
  transport?: "local_capture" | "smtp" | null;
  url: string;
};

export function invitationDeliveryLabel(
  invitation: Pick<InvitationRow, "delivery" | "transport">,
): string {
  if (invitation.delivery !== "sent")
    return invitation.delivery === "not_requested"
      ? "Unsent"
      : invitation.delivery;
  if (invitation.transport === "smtp")
    return "SMTP accepted (not inbox confirmed)";
  if (invitation.transport === "local_capture")
    return "Captured locally (not emailed)";
  return "Transport accepted (historical transport unknown)";
}

export function TeamAccessPanel(
  props: Readonly<{
    members: MemberRow[];
    invitations: InvitationRow[];
    deliveryAvailable?: boolean;
    deliveryTransport?: "local_capture" | "smtp";
    deliveryUnavailableReason?: string;
    onCopy(url: string): void;
    onSend(id: string, uncertainResendConfirmed: boolean): void | Promise<void>;
    onRevoke(id: string): void | Promise<void>;
  }>,
) {
  const [pending, setPending] = useState<Record<string, "send" | "revoke">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const run = async (
    id: string,
    action: "send" | "revoke",
    operation: () => void | Promise<void>,
  ) => {
    if (pending[id]) return;
    setPending((current) => ({ ...current, [id]: action }));
    setErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    try {
      await operation();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : "Request failed",
      }));
    } finally {
      setPending((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };
  return (
    <section className="team-access-panel" aria-label="Members and invitations">
      <div className="access-list">
        <h3>Members</h3>
        {props.members.map((member) => (
          <article className="access-row" key={member.id}>
            <span>{member.email}</span>
            <strong>{member.role}</strong>
          </article>
        ))}
      </div>
      <div className="access-list">
        <h3>Invitations</h3>
        <p>
          {props.deliveryTransport === "smtp"
            ? "SMTP delivery enabled; acceptance does not confirm inbox delivery."
            : "Local capture only; invitations are not emailed."}
        </p>
        {props.invitations.map((invitation) => {
          const pendingAction = pending[invitation.id];
          let sendLabel: "Send" | "Retry" | "Resend" | null = null;
          if (invitation.url && invitation.delivery === "not_requested")
            sendLabel = "Send";
          else if (invitation.url && invitation.delivery === "failed")
            sendLabel = "Retry";
          else if (invitation.url && invitation.delivery === "uncertain")
            sendLabel = "Resend";
          return (
            <article className="access-row invitation-row" key={invitation.id}>
              <span>{invitation.email}</span>
              <strong>{invitation.role}</strong>
              <span aria-label={`Delivery ${invitation.delivery}`}>
                {invitationDeliveryLabel(invitation)}
              </span>
              {invitation.url ? (
                <input
                  aria-label={`Invitation link for ${invitation.email}`}
                  readOnly
                  value={invitation.url}
                />
              ) : (
                <span>Link unavailable for this earlier invitation</span>
              )}
              <div className="row-actions">
                {invitation.url && (
                  <button
                    type="button"
                    onClick={() => props.onCopy(invitation.url)}
                    aria-label={`Copy link for ${invitation.email}`}
                  >
                    Copy link
                  </button>
                )}
                {sendLabel && (
                  <button
                    type="button"
                    disabled={
                      Boolean(pendingAction) ||
                      props.deliveryAvailable === false
                    }
                    aria-label={`${pendingAction === "send" ? "Sending" : sendLabel} ${invitation.email}`}
                    onClick={() => {
                      if (
                        invitation.delivery !== "uncertain" ||
                        window.confirm(
                          "The prior delivery outcome is uncertain. Send again?",
                        )
                      )
                        void run(invitation.id, "send", () =>
                          props.onSend(
                            invitation.id,
                            invitation.delivery === "uncertain",
                          ),
                        );
                    }}
                  >
                    {pendingAction === "send" ? "Sending…" : sendLabel}
                  </button>
                )}
                {sendLabel &&
                  props.deliveryAvailable === false &&
                  props.deliveryUnavailableReason && (
                    <span className="delivery-unavailable">
                      {props.deliveryUnavailableReason}
                    </span>
                  )}
                {invitation.lifecycle === "pending" && (
                  <button
                    type="button"
                    disabled={Boolean(pendingAction)}
                    onClick={() =>
                      void run(invitation.id, "revoke", () =>
                        props.onRevoke(invitation.id),
                      )
                    }
                    aria-label={`${pendingAction === "revoke" ? "Revoking" : "Revoke"} ${invitation.email}`}
                  >
                    {pendingAction === "revoke" ? "Revoking…" : "Revoke"}
                  </button>
                )}
              </div>
              {errors[invitation.id] && (
                <p role="alert">{errors[invitation.id]}</p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
