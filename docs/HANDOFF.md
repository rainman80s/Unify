# Unify Studio — project handoff for Claude

## Start here
Ranen wants you to continue developing this idea with him. Review this brief and the included `index.html` prototype, explain what is actually built, and collaborate on the next concrete steps. Ask before spending money or connecting accounts. Preserve his vision while being honest about provider rules and technical constraints.

## The vision, in Ranen's words (condensed)
Build an app that brings multiple AI providers and APIs into a unified chat and project workspace, potentially running up to 16 AIs simultaneously. The most important feature is an efficient, continuously updated context engine that enables smooth handoffs among providers when usage limits or availability interrupt work. Users should be able to set a priority order, e.g. Claude Code, then Codex, then other choices such as DeepSeek, so large projects can keep moving. The context must already be available when a provider runs out; don't rely on asking the exhausted provider to summarize afterward.

A My AIs area should offer account-based connections when officially supported, plus API credentials (e.g. DeepSeek), and discovery of providers such as the NVIDIA model catalog for text and potentially image generation. Do not promise unlimited usage or assume NVIDIA models are permanently free. Ranen wants to use included subscription allowances where supported, not require APIs for everything. Investigate provider-specific rules, OAuth and capabilities. Support image-generation workflows eventually. Include privacy and cost controls, and avoid silent paid API fallbacks.

Design: clean, familiar AI chat, light and dark modes, modern macOS 26 liquid-glass influence. The long-term goal is an installable Mac desktop app; Electron is familiar but architecture should be chosen on merits. Ranen is currently on his phone and appreciates a cloud preview. Working title Unify or unify.js, subject to brand and trademark checks. Existing AI products already use Unify; no alternative has been cleared.

## What exists
Private cloud preview: https://unify-studio-concept.timelycrocus1.chatgpt.site

The included `index.html` is the entire source for the deployed static concept as of November 13, 2026. Open it in a browser to explore it. It has a sample chat and handoff, simulated My AIs cards, a sample checkpoint, a handoff priority view, and light/dark mode. These are interface demos only. The priority move buttons change the displayed order temporarily; chat drafts are local to the current page, and navigation may clear them. No AI, backend, authentication, API, persistent context, real usage monitoring, or real handoff is implemented. It is not an installable desktop app. The preview is private and Claude may not be able to access its URL; use the included source.

## Provider research to verify before implementation
- OpenAI describes using eligible ChatGPT plan allowances in participating third-party apps, subject to integration, eligibility, user permissions, and current terms: https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites
- Anthropic states Claude Pro and Claude API usage are separate: https://support.claude.com/en/articles/8325606-what-is-the-pro-plan . Verify current rules for Claude Code, SDKs, and third-party harnesses directly with Anthropic; don't assume a subscription is transferable.
- Gemini API billing and quotas: https://ai.google.dev/gemini-api/docs/billing . Verify any subscription integration separately.
- NVIDIA developer catalog / NIM: https://developer.nvidia.com/nim . Verify each model's current availability, cost, terms, rate limits, image capabilities, and production rights.
- Unify name collisions: https://www.unify.ai/ and https://unifycore.ai/ai-chat . These are initial discoveries, not a trademark search.

## Suggested technical direction, not implemented
1. Project-owned canonical state independent of each model: event history, durable checkpoints, selected source files, decisions, constraints, tasks, and audit/provenance. Avoid treating a summary as the sole source of truth.
2. Provider adapters expose capabilities, authentication method, limits/errors, costs, context-window constraints, and supported tools. Use only authorized integrations.
3. Create task-specific handoff packets from the most relevant current state and underlying artifacts. Save incremental state during work so handoff doesn't require a final call to the exhausted model. Preserve model provenance and surface missing or stale context.
4. A router follows user-set priorities, checks capability and availability, handles rate limits and incomplete actions safely, and asks before crossing a spending threshold. Retrying tools and code execution must avoid duplicate or partial actions.
5. Define simultaneous-agent coordination, file conflicts, task ownership, result review, and human approval for consequential actions; do not assume that 16 parallel models automatically improve results.
6. For an initial real MVP, choose two providers with supported connections, implement durable projects and one controlled handoff, add tests covering context continuity and failure handling, then iterate on the Mac client.

## Important constraints
Do not treat this as a completed product. The prototype contains no credentials. Never ask Ranen to paste secret API keys into an insecure chat; design a secure connection flow. Recheck time-sensitive provider terms and pricing. The Sites project source is not a public GitHub repository, and this package includes a copy of the prototype, not any of Ranen's other Claude projects.
