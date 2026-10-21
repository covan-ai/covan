import { AppLogo } from "@/components/integrations/app-logo";
import { PROVIDER_MARK, SlackMark } from "@/components/integrations/brand-marks";
import { assetSrc } from "@/lib/api-client";
import { composioLogoPath, type ToolEntry } from "@/lib/onboarding-config";

/**
 * The mark of a tool from the first run's catalogue, in the neutral tile.
 *
 * The three sources we draw ourselves take their marks from `brand-marks.tsx`;
 * everything else is fetched through our own logo proxy, and a mark that does
 * not load becomes a monogram, as `AppLogo` does everywhere.
 */
export function ToolLogo({
  tool,
  size = 36,
  className,
}: {
  tool: ToolEntry;
  size?: 28 | 36 | 44;
  className?: string;
}) {
  const { logo } = tool;
  if (logo.kind === "provider") {
    return (
      <AppLogo
        mark={PROVIDER_MARK[logo.provider]}
        name={tool.name}
        size={size}
        className={className}
      />
    );
  }
  if (logo.kind === "slack") {
    return <AppLogo mark={SlackMark} name={tool.name} size={size} className={className} />;
  }
  return (
    <AppLogo
      src={assetSrc(composioLogoPath(logo.slug))}
      name={tool.name}
      size={size}
      className={className}
    />
  );
}
