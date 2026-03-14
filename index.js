#!/usr/bin/env node
// ../../opt/gpubridge/src/mcp-server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
var API_BASE = process.env.GPUBRIDGE_URL || "https://api.gpubridge.xyz";
var API_KEY = process.env.GPUBRIDGE_API_KEY || "";
var server = new Server(
  { name: "gpu-bridge", version: "2.0.0" },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gpu_run",
      description: "Run any GPU-Bridge AI service. 30 services available: LLM inference (sub-second), image generation (FLUX, SD3.5), video generation, video enhancement (up to 4K), speech-to-text (Whisper, <1s), TTS (40+ voices), music generation, voice cloning, embeddings, document reranking (Jina), OCR, PDF/document parsing, NSFW detection, image captioning, visual Q&A, background removal, face restoration, upscaling, stickers, and more. Use gpu_catalog to see all available services.",
      inputSchema: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description: "Service key. Common ones: llm-4090 (text), image-4090 (image), video (video), whisper-l4 (speech-to-text), tts-l4 (text-to-speech), embedding-l4 (embeddings), rembg-l4 (bg removal), upscale-l4 (upscale), ocr (text extraction), caption (image caption), face-restore, musicgen-l4, llava-4090 (visual Q&A), sticker, whisperx (diarized STT), bark (expressive TTS), voice-clone, photomaker, ad-inpaint, animate, image-variation, inpaint, controlnet, clip, segmentation, rerank (document reranking), nsfw-detect (content moderation), video-enhance (video upscaling), pdf-parse (document parsing)"
          },
          input: {
            type: "object",
            description: 'Service-specific input. Examples: LLM {"prompt":"...","max_tokens":512,"model":"llama-3.3-70b-versatile"}, Image {"prompt":"..."}, Whisper {"audio_url":"https://..."}, TTS {"text":"...","voice":"af_alloy"}, Embedding {"text":"..."}, OCR/Rembg/Upscale/Caption {"image_url":"https://..."}, Video {"prompt":"..."}'
          },
          priority: {
            type: "string",
            enum: ["fast", "cheap"],
            description: 'Routing priority. "fast" = lowest latency (default), "cheap" = lowest cost.'
          }
        },
        required: ["service", "input"]
      }
    },
    {
      name: "gpu_catalog",
      description: "List all available GPU-Bridge services with pricing and model info. No authentication required.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "gpu_status",
      description: "Check the status of a GPU-Bridge job and retrieve results.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "The job ID returned by gpu_run" }
        },
        required: ["job_id"]
      }
    },
    {
      name: "gpu_balance",
      description: "Check GPU-Bridge credit balance, daily spend, volume discount tier, and job history.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "gpu_estimate",
      description: "Estimate the cost of a GPU-Bridge service before running it. No authentication required.",
      inputSchema: {
        type: "object",
        properties: {
          service: { type: "string", description: "Service key (e.g. llm-4090, image-4090)" },
          seconds: { type: "number", description: "Estimated runtime in seconds (optional)" }
        },
        required: ["service"]
      }
    }
  ]
}));
async function apiCall(endpoint, method, body, headers) {
  const h = { "Content-Type": "application/json", ...headers };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: h,
    ...body && { body: JSON.stringify(body) }
  });
  return res.json();
}
async function pollJob(jobId, maxWait = 3e5) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const status = await apiCall(`/status/${jobId}`, "GET");
    if (status.status === "completed") return status;
    if (status.status === "failed") {
      const msg = status.error || "Job failed";
      const refund = status.refunded ? ` (refunded $${status.refund_amount_usd})` : "";
      throw new Error(`${msg}${refund}`);
    }
    const elapsed = Date.now() - start;
    await new Promise((r) => setTimeout(r, elapsed < 1e4 ? 1e3 : 3e3));
  }
  throw new Error("Job timed out waiting for result");
}
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "gpu_run": {
        const { service, input, priority } = args;
        const headers = {};
        if (priority) headers["X-Priority"] = priority;
        const job = await apiCall("/run", "POST", { service, input }, headers);
        if (job.error) {
          return { content: [{ type: "text", text: `Error: ${job.error}${job.hint ? `
Hint: ${job.hint}` : ""}${job.available_services ? `
Available: ${job.available_services.join(", ")}` : ""}` }], isError: true };
        }
        const result = await pollJob(job.job_id);
        const output = result.output;
        let text;
        if (typeof output === "string") {
          text = output;
        } else if (output?.text) {
          text = output.text;
        } else if (output?.url) {
          text = output.url;
        } else if (output?.audio_url) {
          text = output.audio_url;
        } else if (output?.embedding) {
          text = `Embedding (${output.dimensions} dimensions): [${output.embedding.slice(0, 5).map((n) => n.toFixed(4)).join(", ")}...]`;
        } else {
          text = JSON.stringify(output, null, 2);
        }
        if (result.output_notice) {
          text += `

Note: ${result.output_notice}`;
        }
        return { content: [{ type: "text", text }] };
      }
      case "gpu_catalog": {
        const catalog = await apiCall("/catalog", "GET");
        const services = catalog.services || [];
        const byCategory = {};
        for (const s of services) {
          const cat = s.category || "other";
          if (!byCategory[cat]) byCategory[cat] = [];
          const pricing = Object.values(s.pricing || {})[0] || `$${s.default_cost_usd}`;
          const models = (s.models || []).length;
          byCategory[cat].push(`  ${s.key} \u2014 ${s.name} (${pricing}${models ? `, ${models} models` : ""})`);
        }
        let text = `GPU-Bridge: ${catalog.active_endpoints} services available

`;
        for (const [cat, items] of Object.entries(byCategory)) {
          text += `${cat.toUpperCase()}:
${items.join("\n")}

`;
        }
        text += `Use gpu_run with service key and input to run any service.
Use gpu_estimate to check cost before running.`;
        return { content: [{ type: "text", text }] };
      }
      case "gpu_status": {
        const { job_id } = args;
        const status = await apiCall(`/status/${job_id}`, "GET");
        let text = `Job ${status.id}: ${status.status}`;
        if (status.progress) {
          text += `
Progress: ${status.progress.phase} (${status.progress.percent_estimate}%, ${status.progress.elapsed_seconds}s elapsed)`;
        }
        if (status.output) {
          const o = status.output;
          if (o.text) text += `
Output: ${o.text}`;
          else if (o.url) text += `
Output: ${o.url}`;
          else if (o.audio_url) text += `
Output: ${o.audio_url}`;
          else text += `
Output: ${JSON.stringify(o)}`;
        }
        if (status.error) {
          text += `
Error: ${status.error}`;
          if (status.refunded) text += ` (refunded $${status.refund_amount_usd})`;
        }
        if (status.output_notice) text += `
Note: ${status.output_notice}`;
        return { content: [{ type: "text", text }] };
      }
      case "gpu_balance": {
        const balance = await apiCall("/account/balance", "GET");
        const vd = balance.volume_discount || {};
        let text = `Balance: $${balance.balance}
Daily spend: $${balance.daily_spend}/$${balance.daily_limit}
Tier: ${vd.tier} (${vd.discount_percent}% discount)`;
        if (vd.next_tier) {
          text += `
Next tier: ${vd.next_tier.name} at $${vd.next_tier.threshold} spent (${vd.next_tier.discountPercent}% discount)`;
        }
        return { content: [{ type: "text", text }] };
      }
      case "gpu_estimate": {
        const { service, seconds } = args;
        const qs = seconds ? `&seconds=${seconds}` : "";
        const est = await apiCall(`/catalog/estimate?service=${service}${qs}`, "GET");
        if (est.error) {
          return { content: [{ type: "text", text: `Error: ${est.error}${est.available_services ? `
Available: ${est.available_services.join(", ")}` : ""}` }], isError: true };
        }
        return { content: [{ type: "text", text: `Service: ${est.service}
Estimated cost: $${est.estimated_cost_usd}
Rate: $${est.price_per_second}/sec
${est.note}` }] };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
  }
});
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main().catch(console.error);
