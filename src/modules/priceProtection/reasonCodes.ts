/** Коды причин для аудита и UI (enforcement + снимки) */
export const ReasonCode = {
  TARGET_MET: "target_met",
  BELOW_MIN_RAISE_PROPOSED: "below_min_raise_proposed",
  BELOW_MIN_RAISE_SUBMITTED: "below_min_raise_submitted",
  SKIPPED_NO_WALLET: "skipped_no_wallet",
  SKIPPED_NO_BASE_PRICE: "skipped_no_base_price",
  SKIPPED_LOW_CONFIDENCE: "skipped_low_confidence",
  SKIPPED_COOLDOWN: "skipped_cooldown",
  SKIPPED_EMERGENCY_STOP: "skipped_emergency_stop",
  SKIPPED_GLOBAL_PAUSE: "skipped_global_pause",
  SKIPPED_QUARANTINE_RISK: "skipped_quarantine_risk",
  SKIPPED_NO_OBSERVED_FINAL: "skipped_no_observed_final",
  SKIPPED_ANOMALOUS_RATIO: "skipped_anomalous_ratio",
  SKIPPED_BELOW_MIN_CHANGE: "skipped_below_min_change",
  SKIPPED_CLAMPED_NO_GAIN: "skipped_clamped_no_gain",
  SKIPPED_CANNOT_REACH_MIN: "skipped_cannot_reach_min",
  SKIPPED_NO_RULE: "skipped_no_rule",
  SKIPPED_CONTROL_OFF: "skipped_control_off",
} as const;

export type ReasonCodeValue = (typeof ReasonCode)[keyof typeof ReasonCode];
