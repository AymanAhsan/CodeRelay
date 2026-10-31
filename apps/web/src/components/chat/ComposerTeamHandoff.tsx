import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  teamHubActionErrorMessage,
  teamHubHandoffOffer,
  type TeamHubHandoffCandidate,
} from "@t3tools/client-runtime/state/team-hub";
import type { EnvironmentId } from "@t3tools/contracts";
import { UsersIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useImperativeHandle, useState, type Ref } from "react";

import { cn } from "~/lib/utils";
import { usePreparedConnection } from "~/state/session";
import { teamHubActionCommand, teamHubStateAtom } from "~/state/teamHub";
import { useAtomCommand } from "~/state/use-atom-command";
import { ComposerBanner } from "./ComposerBanner";

export interface ComposerTeamHandoffHandle {
  /** Shows the handoff choice when a teammate's areas match `prompt`. Returns whether it did. */
  offer: (prompt: string) => boolean;
}

interface Offer {
  readonly prompt: string;
  readonly candidates: ReadonlyArray<TeamHubHandoffCandidate>;
  readonly step: "choose" | "who";
}

interface HandoffChoice {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly select: () => void;
}

function describeCandidate(candidate: TeamHubHandoffCandidate) {
  const area =
    candidate.matchedDomains.length > 0
      ? `Owns ${candidate.matchedDomains.join(", ")}`
      : "No matching areas";
  return `${area} · ${candidate.member.online ? "online" : "offline, sees it when they're back"}`;
}

/**
 * Offers to hand a prompt to a teammate whose areas cover it instead of sending it to this
 * thread's agent. Keeping it sends as usual; handing off posts a team task for that teammate.
 */
export function ComposerTeamHandoff({
  ref,
  environmentId,
  repositoryKey,
  onKeep,
  onHandedOff,
}: {
  readonly ref?: Ref<ComposerTeamHandoffHandle>;
  readonly environmentId: EnvironmentId;
  readonly repositoryKey: string | null | undefined;
  readonly onKeep: () => void;
  readonly onHandedOff: (memberName: string) => void;
}) {
  const state = Option.getOrNull(
    AsyncResult.value(useAtomValue(teamHubStateAtom({ environmentId, input: {} }))),
  );
  const prepared = usePreparedConnection(environmentId);
  const command = useAtomCommand(teamHubActionCommand, { reportFailure: false });
  const [offer, setOffer] = useState<Offer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      offer: (prompt) => {
        const candidates = teamHubHandoffOffer(state, repositoryKey, prompt);
        if (candidates === null) return false;
        setError(null);
        setOffer({ prompt: prompt.trim(), candidates, step: "choose" });
        return true;
      },
    }),
    [repositoryKey, state],
  );

  const handOff = async (memberId: string, memberName: string) => {
    if (offer === null || Option.isNone(prepared)) return;
    setBusy(true);
    setError(null);
    const outcome = await command({
      prepared: prepared.value,
      action: {
        type: "publish",
        input: { type: "post_task", assigneeId: memberId, text: offer.prompt, contract: null },
      },
    });
    setBusy(false);
    if (!AsyncResult.isSuccess(outcome)) {
      setError(teamHubActionErrorMessage(squashAtomCommandFailure(outcome)));
      return;
    }
    setOffer(null);
    onHandedOff(memberName);
  };

  const best = offer?.candidates[0];
  const options: HandoffChoice[] =
    offer === null
      ? []
      : offer.step === "choose"
        ? [
            {
              key: "handoff",
              label: "Hand off to a teammate",
              description: best ? `Best fit: ${best.member.name} · ${describeCandidate(best)}` : "",
              select: () => setOffer({ ...offer, step: "who" }),
            },
            {
              key: "keep",
              label: "Keep it with my agent",
              description: "Send it to this thread as usual",
              select: () => {
                setOffer(null);
                onKeep();
              },
            },
          ]
        : offer.candidates.map((candidate) => ({
            key: candidate.member.id,
            label: candidate.member.name,
            description: describeCandidate(candidate),
            select: () => void handOff(candidate.member.id, candidate.member.name),
          }));

  // Number keys pick options while focus is outside editable fields, like agent questions.
  useEffect(() => {
    if (options.length === 0 || busy) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement &&
          target.closest('[contenteditable]:not([contenteditable="false"])'))
      )
        return;
      const option = options[Number.parseInt(event.key, 10) - 1];
      if (!option) return;
      event.preventDefault();
      option.select();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, options]);

  if (offer === null) return null;

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root
        role="region"
        aria-label="Hand off to a teammate"
        data-chat-composer-collapsed-controls="true"
        className="relative z-0"
      >
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <UsersIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="shrink-0 font-medium text-muted-foreground">Team handoff</span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Dismiss
              aria-label="Cancel and keep editing"
              title="Cancel and keep editing"
              disabled={busy}
              onClick={() => setOffer(null)}
            />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Scroll>
          <ComposerBanner.Body className="pe-1 pb-1 wrap-anywhere">
            <p className="text-sm text-foreground/85">
              {offer.step === "choose"
                ? "This looks like it's in a teammate's area. Hand it off?"
                : "Who should take it?"}
            </p>
            <div className="mt-2 space-y-0.5">
              {options.map((option, index) => (
                <button
                  key={option.key}
                  type="button"
                  disabled={busy}
                  onClick={option.select}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-md bg-transparent px-2.5 py-2 text-left text-foreground/85 outline-none transition-colors duration-150 hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-primary/25",
                    busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="text-secondary-label text-2xs">{option.description}</span>
                    ) : null}
                  </div>
                  {index < 9 ? (
                    <kbd className="flex size-5 shrink-0 items-center justify-center text-3xs font-medium text-muted-foreground tabular-nums">
                      {index + 1}
                    </kbd>
                  ) : null}
                </button>
              ))}
            </div>
            {error ? (
              <p role="alert" className="mt-2 text-xs text-error">
                {error}
              </p>
            ) : null}
          </ComposerBanner.Body>
        </ComposerBanner.Scroll>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}
