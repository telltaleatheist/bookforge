export interface AnalysisCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  enabled: boolean;
}

/** Shared defaults for every content-analysis entry point. */
export const DEFAULT_ANALYSIS_CATEGORIES: readonly AnalysisCategory[] = [
  { id: 'thought_control', name: 'Thought Control', color: '#E53935', enabled: true, description: 'Discouraging critical thinking, independent thought, or questioning authority; demanding blind obedience' },
  { id: 'information_control', name: 'Information Control', color: '#1565C0', enabled: true, description: 'Discouraging outside sources; labeling criticism as persecution; controlling what members read/watch' },
  { id: 'us_vs_them', name: 'Us vs. Them', color: '#FB8C00', enabled: true, description: 'In-group/out-group divisions; dehumanizing outsiders; framing the world as hostile' },
  { id: 'fear_manipulation', name: 'Fear & Doom', color: '#7B1FA2', enabled: true, description: 'Apocalyptic fearmongering; divine punishment threats; urgency through fear' },
  { id: 'loaded_language', name: 'Loaded Language', color: '#00838F', enabled: true, description: 'Thought-terminating cliches; euphemisms masking harmful practices; jargon replacing critical thinking' },
  { id: 'emotional_manipulation', name: 'Emotional Manipulation', color: '#C62828', enabled: true, description: 'Guilt-tripping; love-bombing; shaming; exploiting grief or vulnerability' },
  { id: 'authority_claims', name: 'Authority Claims', color: '#4527A0', enabled: true, description: 'Claiming divine mandate; unquestionable leadership; special revelation' },
  { id: 'historical_revisionism', name: 'Historical Revisionism', color: '#2E7D32', enabled: true, description: 'Rewriting history; false narratives; cherry-picking facts; pseudohistory' },
  { id: 'scapegoating', name: 'Scapegoating', color: '#D84315', enabled: true, description: 'Blaming specific groups; conspiracy theories about minorities; racial/ethnic targeting' },
  { id: 'violence_glorification', name: 'Violence & Extremism', color: '#B71C1C', enabled: true, description: 'Justifying violence; martyrdom ideology; eliminationist rhetoric' },
  { id: 'false_prophecy', name: 'False Prophecy', color: '#8E24AA', enabled: true, description: 'Failed predictions presented as divine truth; date-setting; unfalsifiable claims' },
  { id: 'shunning', name: 'Shunning & Isolation', color: '#6D4C41', enabled: true, description: 'Social isolation tactics; cutting off family/friends; punishment for leaving' },
];
