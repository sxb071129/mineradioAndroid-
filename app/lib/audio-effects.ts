export type AudioEffectPreset = "original" | "auto" | "bass" | "vocal" | "night";

export type AudioEffectDefinition = {
  id: AudioEffectPreset;
  label: string;
  shortLabel: string;
  description: string;
  lowGain: number;
  presenceGain: number;
  highGain: number;
  threshold: number;
  knee: number;
  ratio: number;
  outputGain: number;
};

export const AUDIO_EFFECTS: readonly AudioEffectDefinition[] = [
  {
    id: "original",
    label: "原声",
    shortLabel: "原声",
    description: "完全旁路音色增益，保留原始动态",
    lowGain: 0,
    presenceGain: 0,
    highGain: 0,
    threshold: 0,
    knee: 0,
    ratio: 1,
    outputGain: 1,
  },
  {
    id: "auto",
    label: "自动·轻微",
    shortLabel: "自动",
    description: "轻微补充细节并控制峰值，适合日常播放",
    lowGain: 0.9,
    presenceGain: 0.7,
    highGain: 0.6,
    threshold: -14,
    knee: 10,
    ratio: 1.45,
    outputGain: 0.96,
  },
  {
    id: "bass",
    label: "低频律动",
    shortLabel: "低频",
    description: "增强鼓点与低频，下压输出防止削波",
    lowGain: 4.2,
    presenceGain: -0.8,
    highGain: 0.4,
    threshold: -12,
    knee: 12,
    ratio: 2.4,
    outputGain: 0.86,
  },
  {
    id: "vocal",
    label: "人声清晰",
    shortLabel: "人声",
    description: "收紧低频并提升人声存在感",
    lowGain: -1.4,
    presenceGain: 3,
    highGain: 1,
    threshold: -14,
    knee: 9,
    ratio: 1.7,
    outputGain: 0.92,
  },
  {
    id: "night",
    label: "夜间柔和",
    shortLabel: "夜间",
    description: "柔化高频并压低峰值，减少突发音量",
    lowGain: 0.7,
    presenceGain: 0.3,
    highGain: -2.6,
    threshold: -22,
    knee: 16,
    ratio: 3.1,
    outputGain: 0.8,
  },
] as const;

export type AudioEffectNodes = {
  low: BiquadFilterNode;
  presence: BiquadFilterNode;
  high: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  output: GainNode;
};

export function getAudioEffect(value: string | null | undefined) {
  return AUDIO_EFFECTS.find((effect) => effect.id === value) || AUDIO_EFFECTS[0];
}

function smooth(param: AudioParam, value: number, now: number) {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.025);
}

export function applyAudioEffect(nodes: AudioEffectNodes, preset: AudioEffectPreset, now: number) {
  const effect = getAudioEffect(preset);
  smooth(nodes.low.gain, effect.lowGain, now);
  smooth(nodes.presence.gain, effect.presenceGain, now);
  smooth(nodes.high.gain, effect.highGain, now);
  smooth(nodes.compressor.threshold, effect.threshold, now);
  smooth(nodes.compressor.knee, effect.knee, now);
  smooth(nodes.compressor.ratio, effect.ratio, now);
  smooth(nodes.output.gain, effect.outputGain, now);
  return effect;
}
