export interface ProviderMetadata {
  name: string;
  website: string;
  description: string;
  freeTier: string;
  category: "Model maker" | "Inference platform";
}

export const PROVIDER_CATALOG: Record<string, ProviderMetadata> = {
  "openrouter-qwen": {
    name: "OpenRouter",
    website: "https://openrouter.ai/settings/keys",
    description: "A broad catalog with multiple models marked as permanently free.",
    freeTier: "20 RPM · 200 requests/day",
    category: "Inference platform",
  },
  "groq-llama": {
    name: "Groq",
    website: "https://console.groq.com/keys",
    description: "Very fast inference across Llama, Qwen, and GPT-OSS models.",
    freeTier: "30 RPM · 1,000 requests/day",
    category: "Inference platform",
  },
  "nvidia-nemotron": {
    name: "NVIDIA NIM",
    website: "https://build.nvidia.com/",
    description: "More than 100 hosted models through NVIDIA's developer program.",
    freeTier: "About 40 requests/minute",
    category: "Inference platform",
  },
  "cerebras-gpt-oss": {
    name: "Cerebras",
    website: "https://cloud.cerebras.ai/",
    description: "Ultra-fast inference with a generous daily token allowance.",
    freeTier: "30 RPM · 1M tokens/day",
    category: "Inference platform",
  },
  mistral: {
    name: "Mistral AI",
    website: "https://console.mistral.ai/api-keys",
    description: "Mistral's experiment plan for text, vision, and code models.",
    freeTier: "~1 RPS · 500K tokens/minute",
    category: "Model maker",
  },
  aion: {
    name: "Aion Labs",
    website: "https://www.aionlabs.ai/",
    description: "Models specialized for roleplay and storytelling.",
    freeTier: "15 RPM · 20K tokens/day",
    category: "Model maker",
  },
  zai: {
    name: "Z AI",
    website: "https://open.bigmodel.cn/usercenter/apikeys",
    description: "Permanent free GLM text and vision models.",
    freeTier: "1 concurrent request",
    category: "Model maker",
  },
  "github-models": {
    name: "GitHub Models",
    website: "https://github.com/marketplace/models",
    description: "Free prototyping with dozens of models for GitHub users.",
    freeTier: "Up to 15 RPM · 150 requests/day",
    category: "Inference platform",
  },
  "hugging-face": {
    name: "Hugging Face",
    website: "https://huggingface.co/settings/tokens",
    description: "One token routes to thousands of community-hosted models.",
    freeTier: "100K inference credits/month",
    category: "Inference platform",
  },
  "kilo-code": {
    name: "Kilo Code",
    website: "https://app.kilo.ai/",
    description: "A changing set of free coding and reasoning models.",
    freeTier: "About 200 requests/hour",
    category: "Inference platform",
  },
  modelscope: {
    name: "ModelScope",
    website: "https://modelscope.cn/my/myaccesstoken",
    description: "Free API inference for registered and verified users.",
    freeTier: "2,000 requests/day total",
    category: "Inference platform",
  },
  sambanova: {
    name: "SambaNova",
    website: "https://cloud.sambanova.ai/",
    description: "Fast inference for several large open-weight models.",
    freeTier: "20 RPM · 200K tokens/day",
    category: "Inference platform",
  },
  siliconflow: {
    name: "SiliconFlow",
    website: "https://cloud.siliconflow.cn/account/ak",
    description: "Permanently free Qwen and DeepSeek-family models.",
    freeTier: "30 RPM · 60K tokens/minute",
    category: "Inference platform",
  },
};
