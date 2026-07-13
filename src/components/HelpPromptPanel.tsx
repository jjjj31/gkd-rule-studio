/** 桌面版"外部 AI Prompt"面板：复制求助 prompt、粘贴 AI 回复提取。安卓版同功能在 AndroidLiteApp 的 AndroidPromptPanel。 */
import { useMemo, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { buildHelpPrompt } from "../lib/helpPrompt";
import { CollapsiblePanel } from "./CollapsiblePanel";
import type { NodePickResult, ParsedGkdSnapshot } from "../types/gkdSnapshot";
import type { RuleSettings } from "../types/ruleDraft";

interface HelpPromptPanelProps {
  snapshot: ParsedGkdSnapshot | null;
  pickResult: NodePickResult | null;
  ruleSettings: RuleSettings;
}

export function HelpPromptPanel({
  snapshot,
  pickResult,
  ruleSettings,
}: HelpPromptPanelProps) {
  const [copied, setCopied] = useState(false);
  const prompt = useMemo(() => {
    return buildHelpPrompt({
      snapshot,
      pickResult,
      ruleSettings,
    });
  }, [snapshot, pickResult, ruleSettings]);

  async function copyPrompt(): Promise<void> {
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1300);
  }

  return (
    <CollapsiblePanel
      actions={
        <button
          className="copy-button"
          disabled={!snapshot}
          type="button"
          onClick={() => void copyPrompt()}
        >
          {copied ? <Check size={15} /> : <ClipboardCopy size={15} />}
          <span>{copied ? "已复制" : "复制求助 prompt"}</span>
        </button>
      }
      className="help-prompt-panel"
      title="AI 求助"
    >
      <p className="preview-note">
        复制后可发给 AI，让它基于当前快照、目标节点和运行参数生成规则。
      </p>
    </CollapsiblePanel>
  );
}
