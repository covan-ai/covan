import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Me, type OnboardingState } from "@/lib/api-client";
import {
  EMPTY_ANSWERS,
  nextStep,
  prevStep,
  progressFor,
  resolveStep,
  type AnswerPatch,
  type FlowContext,
  type OnboardingAnswers,
  type OnboardingStep,
} from "@/lib/onboarding-flow";
import { CTA } from "@/lib/onboarding-config";
import { flushEvents, installUnloadFlush, trackStep } from "@/lib/analytics";
import { markKickoff } from "@/lib/chat-kickoff";
import { useIsHosted } from "@/lib/credits";
import { useAgentsStore } from "@/lib/agents-store";
import { supabase } from "@/lib/supabase/client";
import { AgentMark } from "@/components/agent-mark";
import { WelcomeLayout } from "@/components/welcome/welcome-layout";
import { AssistantStep, type AssistantAnswer } from "@/components/welcome/assistant-step";
import { FirstDocsStep } from "@/components/welcome/first-docs-step";
import { WorkspaceStep } from "@/components/welcome/workspace-step";
import { InviteAcceptStep } from "@/components/welcome/invite-accept-step";

type WelcomeSearch = { step?: string; agent?: string; s?: string };

export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
  // The step is a hint, not an instruction: resolveStep decides what is
  // actually shown, so anything typed here is harmless.
  validateSearch: (search: Record<string, unknown>): WelcomeSearch => ({
    step: typeof search.step === "string" ? search.step : undefined,
    agent: typeof search.agent === "string" ? search.agent : undefined,
    s: typeof search.s === "string" ? search.s : undefined,
  }),
  head: () => ({ meta: [{ title: "Welcome · Covan" }] }),
});

/** The one form on screen, which the card's primary button submits. */
const FORM_ID = "welcome-step";

/**
 * The first run (A14, A29): name the workspace, set up the first agent, give
 * it its first documents — with an invitation in front when one is waiting.
 *
 * Every answer is saved as it is given (`record`), so a reload resumes where
 * it stopped. The agent is made when its step is left (`finish_onboarding`),
 * and the documents step that follows already belongs to a finished run: its
 * agent arrives in the address, and leaving it either way leaves the run.
 */
function Welcome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hosted = useIsHosted();
  const { agents } = useAgentsStore();

  const { data: me, isError: meFailed } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
  });
  // 0115: an account that signed up to an invitation has no workspace, and
  // /me answers null for it. Its answers are still its own.
  const noWorkspace = me === null;
  const { data: ownOnboarding, isPending: ownOnboardingPending } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.onboarding.get(),
    enabled: noWorkspace,
  });
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  const [declinedInvite, setDeclinedInvite] = useState(readDeclined);

  // The workspace's name given at sign-up, carried in the account's metadata
  // (sign-up.tsx): the first step starts on it.
  const [suggestedName, setSuggestedName] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      const given = data.session?.user?.user_metadata?.workspace_name;
      if (active && typeof given === "string" && given.trim()) setSuggestedName(given.trim());
    });
    return () => {
      active = false;
    };
  }, []);

  const search = Route.useSearch();
  const state: OnboardingState | undefined = noWorkspace ? ownOnboarding : me?.onboarding;
  const completed = state?.completed ?? false;
  const agentId = search.agent ?? null;

  const finishing = useRef(false);
  const [ending, setEnding] = useState(false);

  // A finished run is over — except on its last step, the documents for the
  // agent it made, which is reached already finished.
  useEffect(() => {
    if (completed && !noWorkspace && !finishing.current && !agentId) {
      void navigate({ to: "/app", replace: true });
    }
  }, [completed, noWorkspace, agentId, navigate]);

  const answers: OnboardingAnswers = state?.answers ?? EMPTY_ANSWERS;
  const ctx = useMemo<FlowContext>(
    () => ({
      answers,
      lastStep: state?.lastStep ?? null,
      hasIncomingInvite: incoming.length > 0 && !declinedInvite,
      hasWorkspace: !noWorkspace,
      completed,
      agentId,
    }),
    [answers, state?.lastStep, incoming.length, declinedInvite, noWorkspace, completed, agentId],
  );

  const ready = (me !== undefined || meFailed) && (!noWorkspace || !ownOnboardingPending);
  const step: OnboardingStep | null = ready ? resolveStep(search.step, ctx) : null;

  useEffect(() => installUnloadFlush(), []);
  const viewed = useRef<string | null>(null);
  useEffect(() => {
    if (!step || viewed.current === step) return;
    viewed.current = step;
    trackStep(step, "viewed");
  }, [step]);

  // Answers in flight, so the finish never runs ahead of the last one.
  const pending = useRef<Promise<unknown>[]>([]);

  const record = (patch: AnswerPatch) => {
    const { lastStep, ...rest } = patch;
    const merged: OnboardingAnswers = { ...answers, ...rest } as OnboardingAnswers;
    const update = (prev: OnboardingState | undefined) =>
      prev ? { ...prev, lastStep: lastStep ?? prev.lastStep, answers: merged } : prev;
    queryClient.setQueryData(["me"], (prev: Me | null | undefined) =>
      prev ? { ...prev, onboarding: update(prev.onboarding) ?? prev.onboarding } : prev,
    );
    queryClient.setQueryData(["onboarding"], update);
    pending.current.push(
      api.onboarding.update(patch).catch(() => {
        // The run goes on; the answer is in the cache and the finish carries
        // the persona itself.
      }),
    );
  };

  const goTo = (next: OnboardingStep | "done", how: "completed" | "skipped") => {
    if (!step) return;
    trackStep(step, how);
    if (next === "done") {
      void complete();
      return;
    }
    record({ lastStep: next });
    void flushEvents();
    void navigate({ to: "/welcome", search: { step: next }, replace: true });
  };

  /** The end of a run that made no agent: an invitation accepted, or Save and exit. */
  const complete = async () => {
    if (finishing.current) return;
    finishing.current = true;
    setEnding(true);
    await Promise.allSettled(pending.current);
    void flushEvents();
    try {
      await api.onboarding.complete();
    } catch {
      // The gate lets them in either way; a run that could not be marked
      // finished is asked again next time, which is the honest outcome.
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/app", replace: true });
    }
  };

  /** "Create Support": the answers, then the agent and its first thread. */
  const createAgent = async (a: AssistantAnswer) => {
    if (finishing.current || !step) return;
    finishing.current = true;
    setEnding(true);
    trackStep(step, "completed");
    record({
      assistantName: a.assistantName,
      assistantAvatar: a.assistantAvatar,
      assistantJobs: a.assistantJobs,
      lastStep: "first-docs",
    });
    await Promise.allSettled(pending.current);
    try {
      const done = await api.onboarding.finish({ persona: a.persona });
      markKickoff(done.sessionId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["me"] }),
        queryClient.invalidateQueries({ queryKey: ["agents"] }),
        queryClient.invalidateQueries({ queryKey: ["sessions"] }),
      ]);
      void flushEvents();
      void navigate({
        to: "/welcome",
        search: { step: "first-docs", agent: done.agentId, s: done.sessionId },
        replace: true,
      });
    } catch {
      toast.error("Couldn't set up the agent. Try again.");
    } finally {
      finishing.current = false;
      setEnding(false);
    }
  };

  const goBack = () => {
    if (!step) return;
    const back = prevStep(step, ctx);
    if (!back) return;
    record({ lastStep: back });
    void navigate({ to: "/welcome", search: { step: back }, replace: true });
  };

  // Whether the step's own form is ready, and whether it is mid-save, as the
  // step reports them — the card's primary button lives outside the form.
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const [busyness, setBusyness] = useState<Record<string, boolean>>({});
  const reportValidity = useCallback(
    (s: string) => (valid: boolean) =>
      setValidity((prev) => (prev[s] === valid ? prev : { ...prev, [s]: valid })),
    [],
  );
  const reportBusy = useCallback(
    (s: string) => (busy: boolean) =>
      setBusyness((prev) => (prev[s] === busy ? prev : { ...prev, [s]: busy })),
    [],
  );
  const onValidity = useMemo(
    () => (step ? reportValidity(step) : undefined),
    [step, reportValidity],
  );
  const onBusy = useMemo(() => (step ? reportBusy(step) : undefined), [step, reportBusy]);

  if (!step || (completed && !noWorkspace && !ending && !agentId)) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-sidebar">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const progress = progressFor(step);
  const back = prevStep(step, ctx) && !ending ? { label: CTA.back, onClick: goBack } : null;
  const valid = validity[step] ?? true;
  const busy = ending || (busyness[step] ?? false);
  const exit = noWorkspace || completed ? undefined : () => void complete();

  if (step === "invite-accept") {
    return (
      <WelcomeLayout
        progress={null}
        stepKey={step}
        title="You've been invited"
        subtitle="Join the team that asked, or start a workspace of your own."
        skip={{
          label: noWorkspace ? "Start my own workspace instead" : "Not now",
          onClick: () => {
            if (noWorkspace) {
              rememberDeclined();
              setDeclinedInvite(true);
            }
            goTo(nextStep(step, { ...ctx, hasIncomingInvite: false }), "skipped");
          },
        }}
        primary={null}
      >
        <InviteAcceptStep
          // Joining is the end of the run, whatever else this flow had planned.
          onJoined={() => goTo("done", "completed")}
          onSkip={() => goTo(nextStep(step, { ...ctx, hasIncomingInvite: false }), "skipped")}
        />
      </WelcomeLayout>
    );
  }

  if (step === "workspace") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title="Name your workspace"
        subtitle="After your team or your company. Everything here can be changed later in Settings."
        back={back}
        formId={FORM_ID}
        onExit={exit}
        primary={{ label: busy ? "Saving…" : CTA.continue, disabled: !valid || busy }}
        below="Next: set up your first agent."
      >
        <WorkspaceStep
          formId={FORM_ID}
          currentName={noWorkspace ? null : (me?.workspace.name ?? null)}
          suggestion={suggestedName}
          onDone={() => goTo(nextStep(step, { ...ctx, hasWorkspace: true }), "completed")}
          onValidityChange={onValidity}
          onBusyChange={onBusy}
        />
      </WelcomeLayout>
    );
  }

  if (step === "assistant") {
    return (
      <AssistantScreen
        key={step}
        progress={progress}
        back={back}
        busy={busy}
        valid={valid}
        exit={exit}
        workspaceName={me?.workspace.name ?? null}
        answers={answers}
        onValidity={onValidity}
        onSubmit={(a) => void createAgent(a)}
      />
    );
  }

  const agent = agents.find((a) => a.id === agentId);
  const open = () =>
    agentId &&
    void navigate({
      to: "/agents/$agentId/chat",
      params: { agentId },
      search: search.s ? { s: search.s } : {},
      replace: true,
    });

  return (
    <WelcomeLayout
      progress={progress}
      stepKey={step}
      wide
      lead={agent ? <AgentMark agent={agent} size={36} /> : null}
      title={`What should ${agent?.name ?? "it"} know?`}
      subtitle="Until it has read something, it is a chat window. These are files most teams already have. Drop them in; nothing leaves the workspace."
      skip={{ label: CTA.skip, onClick: () => void navigate({ to: "/app", replace: true }) }}
      primary={{ label: `Open ${agent?.name ?? "it"}`, onClick: open, disabled: !agentId }}
      below={
        hosted ? "The first document in Knowledge earns the workspace 200 credits." : undefined
      }
    >
      {agent ? (
        <FirstDocsStep agent={agent} />
      ) : (
        <p className="m-0 text-sm text-muted-foreground">Loading…</p>
      )}
    </WelcomeLayout>
  );
}

/** The agent step, with its name in the primary button as it is typed. */
function AssistantScreen({
  progress,
  back,
  busy,
  valid,
  exit,
  workspaceName,
  answers,
  onValidity,
  onSubmit,
}: {
  progress: { index: number; count: number } | null;
  back: { label: string; onClick: () => void } | null;
  busy: boolean;
  valid: boolean;
  exit: (() => void) | undefined;
  workspaceName: string | null;
  answers: OnboardingAnswers;
  onValidity: ((valid: boolean) => void) | undefined;
  onSubmit: (a: AssistantAnswer) => void;
}) {
  const [name, setName] = useState(answers.assistantName ?? "");
  return (
    <WelcomeLayout
      progress={progress}
      stepKey="assistant"
      title="Set up your first agent"
      subtitle="Give it a name, a face and a job. Everything here can be changed later in its Configuration."
      back={back}
      formId={FORM_ID}
      onExit={exit}
      primary={{
        label: busy ? CTA.finishing : `Create ${name.trim() || "it"}`,
        disabled: !valid || busy,
      }}
      below="Next: add the first documents it should know."
    >
      <AssistantStep
        formId={FORM_ID}
        workspaceName={workspaceName}
        value={answers}
        onNameChange={setName}
        onSubmit={onSubmit}
        onValidityChange={onValidity}
      />
    </WelcomeLayout>
  );
}

const DECLINED_KEY = "covan:welcome:declined-invite";

function readDeclined(): boolean {
  try {
    return sessionStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDeclined(): void {
  try {
    sessionStorage.setItem(DECLINED_KEY, "1");
  } catch {
    // A refused write forgets the choice on reload, which asks again.
  }
}
