"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Modal built on the native <dialog> element (focus trapping, Escape to close
 * and inert background come from the browser).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : undefined}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <>
          <div className="dialog-body">
            <h2 id={titleId}>{title}</h2>
            {children}
          </div>
          <div className="dialog-actions">
            {actions ?? (
              <button type="button" className="btn" onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </>
      ) : null}
    </dialog>
  );
}

/** Confirmation dialog for consequential actions such as alias moves. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  danger = false,
  pending = false,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={pending ? () => undefined : onCancel}
      title={title}
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button type="button" className={danger ? "btn btn-danger solid" : "btn btn-primary"} onClick={onConfirm} disabled={pending} autoFocus>
            {pending ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}
      {children}
    </Modal>
  );
}
