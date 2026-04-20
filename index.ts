/**
 * Task Tool - Minimal echo example
 */

import { Type } from "@mariozechner/pi-ai";
import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Echoes a message back",
    parameters: Type.Object({
      message: Type.String({ description: "The string to echo" }),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      return {
        content: [{ type: "text", text: `Echo: ${params.message}` }],
        details: { echoed: params.message },
      };
    },
  });
}
