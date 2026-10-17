import {
  ArrowLeft,
  AudioLines,
  Bot,
  Cpu,
  FlaskConical,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { type SettingsSection, useNavigate } from "@/app/router";
import { Nav, NavItem, Sidebar, SidebarBrand } from "@/components/layout/shell";
import { useSettingsSaving } from "@/features/settings/saver";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: React.ReactNode;
}[] = [
  { id: "providers", label: "Providers", icon: <Server size={16} /> },
  { id: "models", label: "Models", icon: <Cpu size={16} /> },
  {
    id: "execution",
    label: "Execution",
    icon: <SlidersHorizontal size={16} />,
  },
  { id: "agent", label: "Agent", icon: <Bot size={16} /> },
  { id: "langfuse", label: "Langfuse", icon: <FlaskConical size={16} /> },
  { id: "voice", label: "Voice", icon: <AudioLines size={16} /> },
];

export function sectionLabel(section: SettingsSection): string {
  return SECTIONS.find((item) => item.id === section)?.label ?? section;
}

export function SettingsNav({ section }: { section: SettingsSection }) {
  const navigate = useNavigate();
  const saving = useSettingsSaving();
  return (
    <Sidebar
      inert={saving}
      footer={
        <Nav label="Application">
          <NavItem
            icon={<ArrowLeft size={16} />}
            label="Back to app"
            active={false}
            onSelect={() => {
              if (!saving) navigate({ name: "discussions" });
            }}
          />
        </Nav>
      }
    >
      <SidebarBrand />
      <Nav label="Settings sections">
        {SECTIONS.map((item) => (
          <NavItem
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={section === item.id}
            onSelect={() => {
              if (!saving) navigate({ name: "settings", section: item.id });
            }}
          />
        ))}
      </Nav>
    </Sidebar>
  );
}
