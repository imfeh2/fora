import type { SettingsSection } from "@/app/router";
import { Page, PageBody, PageHeader } from "@/components/layout/shell";
import { AgentPanel } from "@/features/settings/agent";
import { ExecutionPanel } from "@/features/settings/execution";
import { LangfusePanel } from "@/features/settings/langfuse";
import { ModelPanel } from "@/features/settings/model";
import { VoicePanel } from "@/features/settings/voice";

function Panel({ section }: { section: SettingsSection }) {
  switch (section) {
    case "providers":
      return <ModelPanel view="providers" />;
    case "models":
      return <ModelPanel view="models" />;
    case "execution":
      return <ExecutionPanel />;
    case "agent":
      return <AgentPanel />;
    case "langfuse":
      return <LangfusePanel />;
    case "voice":
      return <VoicePanel />;
  }
}

function SettingsPageContent({ section }: { section: SettingsSection }) {
  return (
    <Page>
      <PageHeader title="Settings" />
      <PageBody>
        <div className="settings-layout">
          <Panel section={section} />
        </div>
      </PageBody>
    </Page>
  );
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  return <SettingsPageContent section={section} />;
}
