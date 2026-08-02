import type { ConversationExportInput } from "../../shared/types";

const escapeHeading = (value: string): string => value.replace(/[\r\n#]+/g, " ").trim();

export function conversationToMarkdown(input: ConversationExportInput, exportedAt = new Date()): string {
  const lines = [
    `# ${escapeHeading(input.conversationName) || "New conversation"}`,
    "",
    `Project: ${escapeHeading(input.projectName)}`,
    "",
    `Exported: ${exportedAt.toISOString()}`,
    "",
  ];
  for (const item of input.items) {
    if (item.type === "message") {
      lines.push(`## ${item.role === "user" ? "User" : "Assistant"}`, "", item.text.trim(), "");
      if (item.attachments?.length) {
        lines.push("Attachments:", "", ...item.attachments.map((attachment) => `- ${attachment.name}`), "");
      }
      continue;
    }
    lines.push("## Plan", "");
    if (item.explanation) lines.push(item.explanation.trim(), "");
    if (item.text) lines.push(item.text.trim(), "");
    if (item.steps.length) {
      lines.push(...item.steps.map((step) => {
        const marker = step.status === "completed" ? "x" : " ";
        const suffix = step.status === "inProgress" ? " _(in progress)_" : "";
        return `- [${marker}] ${step.step}${suffix}`;
      }), "");
    }
  }
  return `${lines.join("\r\n").trimEnd()}\r\n`;
}
