export const states=['needs_review','dialogue_ready','absence_until','cooldown_until','closed','permanent_suppression'] as const;
export type ConversationStatus=typeof states[number];
export type ConversationRules={enabled:boolean;allowModel:boolean;absenceReminders:boolean;rejectionCooldown:boolean;absenceDelayDays:number;cooldownDays:number};
export const defaultConversationRules=():ConversationRules=>({enabled:false,allowModel:false,absenceReminders:true,rejectionCooldown:true,absenceDelayDays:1,cooldownDays:90});
