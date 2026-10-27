// PG1 Sandbox viewer: the History panel's text for worlds inspired by
// history (a world holds a `chronicle` entity naming its history). Every
// statement here is sourced in docs/sandbox-benin-warri.md (its keys are
// given); real people appear here only, never in the world itself.

export const HISTORIES = Object.freeze({
  'benin-warri': Object.freeze({
    title: 'Benin and Warri c. 1610',
    label: 'Simulation inspired by history; inhabitants are fictional.',
    intro: 'This world is set around 1610. Its people, rulers and storylines are invented. The history below is the real background, with its sources. Both royal houses, the Oba of Benin\'s and the Olu of Warri\'s, still reign today.',
    timeline: [
      { when: 'c. 1500 BCE to the last centuries BCE', text: 'The Nok culture of central Nigeria makes its fired-clay sculptures: far older than this world. One Nok site is in it, to be discovered.', sources: 'Goethe University Frankfurt Nok project; G. Franke, Potsherds in time (2015)' },
      { when: 'c. 1480 (tradition)', text: 'Itsekiri and Benin traditions say Warri was founded by Ginuwa, a prince of Benin. In tradition his party came by the Forcados and Warri rivers to Ijala; the capital later moved to Ode-Itsekiri.', sources: 'W. A. Moore, History of Itsekiri (1936), oral tradition; Wikipedia, "Ginuwa I", "Ijala" (secondary)' },
      { when: 'c. 1486', text: 'The Portuguese open a trading post at Ughoton (Gwato), Benin\'s river port.', sources: 'A. F. C. Ryder, Benin and the Europeans 1485–1897 (1969)' },
      { when: '1571–74', text: 'An Augustinian mission from São Tomé, begun under Bishop Gaspar Cão, visits Warri and baptises the heir, who takes the name Sebastião.', sources: 'J. Kenny, The Catholic Church in Tropical Africa, ch. 3, and documentary history; A. F. C. Ryder (1960)' },
      { when: '1574', text: 'A Carmelite letter: the king of Warri is Christian, but there are no priests there.', sources: 'J. Kenny, The Catholic Church in Tropical Africa, ch. 3' },
      { when: '1597', text: 'A report from São Tomé: no priest is going to Warri, because of the climate and because the Olu cannot pay for one. There is no resident priest and no church.', sources: 'J. Kenny, documentary history: consulta of 28 September 1597' },
      { when: '1600–1611', text: 'Dom Domingos, son of the Olu (Dom Sebastião in Portuguese records), studies in Portugal: at a Hieronymite college in Coimbra, then at Augustinian and Jesuit colleges in Lisbon.', sources: 'J. Fonseca, "Portugal e o reino de Oere" (Anais de História de Além-Mar, 2016); J. Kenny, documentary history' },
      { when: '23 November 1607', text: 'At Domingos\' request on his father\'s behalf, King Philip grants that Warri\'s ports be opened to Portuguese commerce.', sources: 'J. Kenny, documentary history (from A. Brásio, Monumenta Missionaria Africana)' },
      { when: 'By June 1610', text: 'Domingos marries Maria Pereira, daughter of Dom Cristóvão Pereira. When they reached Warri is disputed: 1610 in some accounts, 1611 in others; he was still in Lisbon in June 1611.', sources: 'J. Fonseca (2016)' },
      { when: '1620', text: 'A report finds Christians only at the capital: Christianity is a practice of the court, alongside local religion.', sources: 'Wikipedia, "Olu Atuwatse I" (secondary, citing Ryder 1960 and Fonseca 2016)' }
    ],
    notes: [
      { head: 'Ode-Itsekiri', text: 'The capital of Warri, among the creeks of the delta, also given the Portuguese name City of Saint Augustine (Santo Agostinho). Jean Barbot, writing in the 1680s (later than 1610), describes it on the river Forcado, about two miles round, surrounded by groves and thickets, the ordinary residence of the king.', sources: 'P. C. Lloyd (1957); A. F. C. Ryder (1960); J. Barbot (1732; Hakluyt Society edition 1992)' },
      { head: 'Benin', text: 'Benin City was ringed by earthworks (iya): a deep ditch and an earth rampart. The Oba ruled with three orders of chiefs, among them the town chiefs and the palace chiefs. The brass casters\' and the ivory carvers\' guilds worked for the Oba.', sources: 'P. J. Darling (1984); R. E. Bradbury (1957); Smarthistory; the British Museum' },
      { head: 'Benin and Warri', text: 'Warri was founded from Benin and was probably subordinate to it in its early years. How far it still depended on Benin by 1610 is not settled by the sources used: one reading sees the Olu\'s baptism as a way to strengthen Warri\'s position toward Benin. The world shows two kingdoms at peace that trade.', sources: 'see docs/sandbox-benin-warri.md, "Benin and Warri in 1610"' },
      { head: 'Neighbours', text: 'The Itsekiri fished and traded along the coast; the Urhobo farmed the hinterland; the Ijaw of the salt-water belt fished and made salt. Their trade depended on each other.', sources: 'O. Ikime, Niger Delta Rivalry (1969); E. J. Alagoa, A History of the Niger Delta (1972)' },
      { head: 'The hard truth', text: 'Portuguese priests came to this coast on trading ships, and were told to support themselves by trading in enslaved people. The trade with Benin and with Warri involved enslaved people as well as ivory, cloth, pepper, coral beads and brass manillas. This simulation never models buying, selling or owning people.', sources: 'J. Kenny, ch. 3; A. F. C. Ryder (1969); J. Fonseca (2016)' },
      { head: 'Left out', text: 'Not in this world, because no solid source was found: a church or resident priest in 1610, a market and chiefs\' quarters at Ode-Itsekiri, cassava, and the two "silver crowns" (a palace tradition; one is gilt silver and one bronze or brass).', sources: 'docs/sandbox-benin-warri.md, "Open questions"' },
      { head: 'The storyline', text: 'Fictional, inspired by history: a prince of Warri comes home from his studies in Lisbon with his Portuguese wife. Both are invented. Nothing they say or do is attributed to Dom Domingos or Maria Pereira.', sources: '' }
    ]
  })
});

export const historyOf = (world) => {
  const c = ((world && world.entities) || []).find((e) => e.kind === 'chronicle' && e.properties && typeof e.properties.history === 'string');
  return c ? HISTORIES[c.properties.history] || null : null;
};
