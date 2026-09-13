// MITRE ATT&CK Heuristic Mapping Engine
const mitreMapping = {
  'IPv4': { id: 'T1090', tactic: 'Command and Control', name: 'Proxy' },
  'domain': { id: 'T1568', tactic: 'Command and Control', name: 'Dynamic Resolution' },
  'URL': { id: 'T1189', tactic: 'Initial Access', name: 'Drive-by Compromise' },
  'FileHash-SHA256': { id: 'T1204', tactic: 'Execution', name: 'User Execution' },
  'FileHash-MD5': { id: 'T1204', tactic: 'Execution', name: 'User Execution' },
  'CVE': { id: 'T1190', tactic: 'Initial Access', name: 'Exploit Public-Facing Application' }
};

export function enrichIndicator(indicatorType, rawValue, confidenceScore) {
  // Fallback to generic C2 channel if the indicator type is unrecognized
  const mapping = mitreMapping[indicatorType] || { id: 'T1008', tactic: 'Command and Control', name: 'Fallback Channels' };

  // Calculate a proprietary risk score to create commercial value
  const baseScore = parseInt(confidenceScore, 10) || 50;
  
  // Heavily weight confirmed vulnerabilities and malware hashes over standard IPs
  const riskMultiplier = (indicatorType === 'CVE' || indicatorType.includes('FileHash')) ? 1.5 : 1.2;
  const finalRiskScore = Math.min(Math.round(baseScore * riskMultiplier), 100);

  return {
    indicator: rawValue,
    type: indicatorType,
    mitre_tactic: mapping.tactic,
    mitre_technique_id: mapping.id,
    mitre_technique_name: mapping.name,
    proprietary_risk_score: finalRiskScore,
    syndication_ready: true,
    enriched_at: new Date().toISOString()
  };
}

export function processBatch(rawIndicators) {
  if (!Array.isArray(rawIndicators)) return [];
  return rawIndicators.map(record => 
    enrichIndicator(record.indicator_type, record.value, record.confidence_score)
  );
}
