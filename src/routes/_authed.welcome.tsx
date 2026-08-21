import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "@/lib/api-client";
import { useIsHosted } from "@/lib/quota";
import {
  resolveStep,
  nextStep,
  stepsFor,
  type AnswerPatch,
  type OnboardingAnswers,
  type OnboardingStep,
} from "@/lib/onboarding-flow";
import {
  ROLE_OPTIONS,
  USE_CASE_OPTIONS,
  TEAM_SIZE_OPTIONS,
  REFERRAL_OPTIONS,
} from "@/lib/onboarding-options";
import { WelcomeLayout } from "@/components/welcome/welcome-layout";
import { QuestionCard } from "@/components/welcome/question-card";
import { WorkspaceStep } from "@/components/welcome/workspace-step";
import { AgentStep } from "@/components/welcome/agent-step";
import { InviteStep } from "@/components/welcome/invite-step";
import { InviteAcceptStep } from "@/components/welcome/invite-accept-step";

export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
  // The step is a hint, not an instruction: resolveStep decides what is
  // actually shown, so anything typed here is harmless.
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  head: () => ({ meta: [{ title: "Welcome · Covan" }] }),
});

const COPY: Record<OnboardingStep, { title: string; subtitle?: string }> = {
  role: { title: "What do you do?", subtitle: "It shapes the agent we start you with." },
  use: { title: "What will you use Covan for?" },
  team: { title: "How big is the team?" },
  source: {
    title: "How did you hear about us?",
    subtitle: "Genuinely useful to us. Skip if you'd rather.",
  },
  workspace: {
    title: "Name your workspace",
    subtitle: "We guessed. Change it if we guessed wrong.",
  },
  agent: {
    title: "Your first agent",
    subtitle: "Shared with everyone. Every conversation stays private.",
  },
  invite: {
    title: "Bring the team",
    subtitle: "Agents are shared, so they get everything you build.",
  },
  "invite-accept": { title: "You've been invited" },
};

const EMPTY_ANSWERS: OnboardingAnswers = {
  role: null,
  useCase: null,
  teamSize: null,
  referralSource: null,
};

function Welcome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });
  const hosted = useIsHosted();

  const { step: requested } = Route.useSearch();

  // Someone who has already finished has no business here — this is the other
  // half of the gate in _authed.tsx.
  const completed = me?.onboarding.completed;
  useEffect(() => {
    if (completed) {
      void navigate({ to: "/app", replace: true });
    }
  }, [completed, navigate]);

  // The answers come from /me, so someone who closed the browser at question
  // two resumes at question two rather than at question one.
  const answers = me?.onboarding.answers;
  const ctx = useMemo(
    () => ({
      answers: answers ?? EMPTY_ANSWERS,
      hosted: hosted === true,
      hasIncomingInvite: incoming.length > 0,
    }),
    [answers, hosted, incoming.length],
  );

  // Wait for the two facts that change the shape of the flow. Rendering before
  // they land would show a card and then take it away.
  const ready = me !== undefined && hosted !== undefined;

  if (!ready || completed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const step = resolveStep(requested, ctx);
  const steps = stepsFor(ctx);

  const goTo = (next: OnboardingStep | "done") => {
    if (next === "done") {
      void api.onboarding
        .complete()
        .catch(() => {
          // Nothing to show the user: they are on their way into the app, and
          // the worst case is meeting this screen once more.
        })
        .finally(async () => {
          await queryClient.invalidateQueries({ queryKey: ["me"] });
          void navigate({ to: "/app", replace: true });
        });
      return;
    }
    void navigate({ to: "/welcome", search: { step: next }, replace: true });
  };

  const advance = () => goTo(nextStep(step, ctx));

  const answer = (patch: AnswerPatch) => {
    const merged = { ...ctx.answers, ...patch };
    // Written into the ["me"] cache directly rather than by refetching: the tap
    // has to advance the screen now, and waiting on a round trip to redraw a
    // card the user has already left would be a stutter for nothing.
    queryClient.setQueryData(["me"], (prev: Me | undefined) =>
      prev ? { ...prev, onboarding: { ...prev.onboarding, answers: merged } } : prev,
    );
    void api.onboarding.update(patch).catch(() => {
      // The answer is a nicety, not a gate. Losing one to a flaky network must
      // not strand someone on a question they have already answered.
    });
    // Advance against the merged answers, so "just me" skips the invite step on
    // the very tap that chose it.
    goTo(nextStep(step, { ...ctx, answers: merged }));
  };

  const copy = COPY[step];

  return (
    <WelcomeLayout
      title={copy.title}
      subtitle={copy.subtitle}
      stepIndex={Math.max(0, steps.indexOf(step))}
      stepCount={steps.length}
    >
      {step === "role" && (
        <QuestionCard
          title={copy.title}
          options={ROLE_OPTIONS}
          value={ctx.answers.role}
          onSelect={(id) => answer({ role: id })}
        />
      )}
      {step === "use" && (
        <QuestionCard
          title={copy.title}
          options={USE_CASE_OPTIONS}
          value={ctx.answers.useCase}
          onSelect={(id) => answer({ useCase: id })}
        />
      )}
      {step === "team" && (
        <QuestionCard
          title={copy.title}
          options={TEAM_SIZE_OPTIONS}
          value={ctx.answers.teamSize}
          onSelect={(id) => answer({ teamSize: id })}
        />
      )}
      {step === "source" && (
        <QuestionCard
          title={copy.title}
          options={REFERRAL_OPTIONS}
          value={ctx.answers.referralSource}
          onSelect={(id) => answer({ referralSource: id })}
          onSkip={advance}
          skipLabel="Skip this one"
        />
      )}
      {step === "workspace" && <WorkspaceStep currentName={me.workspace.name} onDone={advance} />}
      {step === "agent" && (
        <AgentStep
          useCase={ctx.answers.useCase}
          defaultModel={me.workspace.defaultModel}
          onDone={advance}
        />
      )}
      {step === "invite" && <InviteStep onDone={advance} />}
      {step === "invite-accept" && <InviteAcceptStep onDone={advance} />}
    </WelcomeLayout>
  );
}
