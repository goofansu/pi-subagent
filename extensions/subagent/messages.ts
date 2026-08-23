import type { Message } from "@earendil-works/pi-ai";

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const parts = msg.content
        .filter((part) => part.type === "text")
        .map((part) => (part as { type: "text"; text: string }).text);
      if (parts.length > 0) return parts.join("");
    }
  }
  return "";
}
