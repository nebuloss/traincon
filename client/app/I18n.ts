// Translations.
//
// Keys are grouped by where they appear. Values may contain {placeholders},
// substituted by t(). Anything returning markup is built in app.js from these
// fragments rather than embedding HTML here, so a translation can never inject
// tags into the page.
//
// French is the reference: the app tracks French trains and the station names
// in the data are French regardless of the interface language.

type Dict = Record<string, string>;

const FR: Dict = {
  'app.title': 'Traincon',
  'app.offline': 'hors ligne',
  'app.localData': 'données locales',
  'app.live': 'direct',
  'app.minutesAgo': '{n} min',

  'theme.auto': 'Auto',
  'theme.light': 'Clair',
  'theme.dark': 'Sombre',
  'theme.group': 'Thème',

  'app.source': 'Code source sur GitHub',

  'tab.watch': 'Mes trains',
  'tab.search': 'Recherche',
  'tab.worst': 'Palmarès',

  'worst.title': 'Palmarès du jour',
  'worst.note': 'Les pires retards enregistrés aujourd’hui, motif SNCF à l’appui.',
  'worst.noKey': 'Les pires retards enregistrés aujourd’hui. Sans clé API SNCF, les motifs ne sont pas disponibles.',
  'worst.noReason': 'Motif non communiqué',
  'worst.running': 'en cours',
  'worst.finished': 'terminé',
  'worst.upcoming': 'pas encore parti',
  'worst.gone': 'hors suivi',
  'worst.empty': 'Aucun retard notable aujourd’hui. Ça arrive.',
  'worst.emptyLive': 'Aucun train en retard ne circule en ce moment.',
  'worst.filterLabel': 'Trains à montrer',
  'worst.filterAll': 'Tous',
  'worst.filterLive': 'En circulation',
  'worst.failed': 'Palmarès indisponible : {error}',
  'nav.label': 'Navigation',

  'watch.dormantTag': 'ne circule pas',
  'watch.dormantBody': 'Hors de la fenêtre de prévision (~8 h), ou ne circule pas aujourd’hui.',
  'watch.unknownTag': 'inconnu',
  'watch.unknownBody': 'Le numéro {n} n’existe pas dans les horaires.',
  'watch.removeBookmark': 'Retirer des favoris',
  'watch.empty.title': 'Aucun train suivi',
  'watch.empty.body': "Cherchez votre train par son numéro, sa destination ou une gare desservie. "
    + "Vous verrez sa progression en direct et l'heure réelle à votre gare.",
  'watch.empty.cta': 'Chercher un train',
  'watch.feedDown': 'Vos {n} train(s) en favori réapparaîtront dès que le flux SNCF sera rétabli.',

  'search.placeholder': 'N° de train, gare, destination…',
  'search.label': 'Rechercher un train',
  'search.clear': 'Effacer',
  'search.prompt': 'Tapez un numéro de train, une gare ou une destination.',
  'search.none': 'Aucun train en circulation ne correspond à « {q} ».',
  'search.feedDown': 'Flux SNCF indisponible — aucune donnée à chercher.',
  'search.results': '{n} résultat(s)',
  'search.cachedAt': 'données locales de {time}',
  'search.failed': 'Recherche indisponible : {error}',
  'search.filter': 'Filtrer par type',
  'family.all': 'Tous',
  'family.tgv': 'TGV',
  'family.ter': 'TER',
  'family.ic': 'Intercités',

  'why.number': 'numéro',
  'why.destination': 'destination',
  'why.origin': 'origine',
  'why.serves': 'dessert {stop}',
  'search.nextStop': 'prochain {stop} {time}',

  'delay.onTime': "à l'heure",
  'delay.minutes': '{sign}{n} min',
  'delay.hours': '{sign}{h} h',
  'delay.hoursMinutes': '{sign}{h} h {m}',
  'delay.cancelled': 'supprimé',
  'delay.cancelledShort': 'SUPPR.',
  'delay.label': 'retard',

  'trend.worsening': '↗ augmente',
  'trend.recovering': '↘ se résorbe',
  'trend.stable': '→ stable',

  'countdown.gone': 'parti',
  'countdown.now': "à l'instant",
  'countdown.minutes': 'dans {m} min',
  'countdown.hours': 'dans {h} h {m}',

  'status.inStation': 'En gare de {stop}',
  'status.notDeparted': 'Pas encore parti — départ prévu à {time}',
  'status.leavesFor': 'Repart vers {stop} à {time}',
  'status.atPlatform': 'À quai',
  'status.arrived': 'Arrivé à {stop}',
  'status.journeyOver': 'Trajet terminé',
  'status.between': 'Entre {from} et {to}',
  'status.legProgress': '{pct} % du tronçon',
  'status.legKm': '{km} km par la voie',
  'status.speed': '~{kmh} km/h',
  'status.cancelled': 'Train supprimé',
  'status.cancelledSub': 'Ne comptez pas sur ce train.',
  'status.unknown': 'Position inconnue',

  'pos.notDeparted': 'pas encore parti de {stop}',
  'pos.arrived': 'arrivé à {stop}',
  'pos.inStation': 'en gare de {stop}',
  'pos.between': 'entre {from} et {to} — {pct} % ({km} km)',
  'pos.unknown': 'inconnue',

  'card.nextStop': 'Prochain arrêt — {stop}',
  'card.arrival': 'Arrivée {stop}',
  'card.cancelledWarning': 'Ne comptez pas sur ce train.',
  'card.alreadyPassed': 'déjà passé',
  'stop.departure': 'départ {time}',

  'modal.close': 'Fermer',
  'mtab.overview': 'Aperçu',
  'mtab.journey': 'Trajet',
  'mtab.map': 'Carte',
  'mtab.journal': 'Journal',
  'modal.detail': 'Détail du train',
  'modal.unknown': 'Le train {n} n’existe pas.',
  'modal.dormant': 'Le train {n} ne circule pas actuellement.',
  'modal.loading': 'Chargement…',

  'ov.terminus': 'Terminus',
  'ov.delay': 'Retard',
  'ov.stopsLeft': 'Arrêts restants',
  'ov.outOf': 'sur {n}',
  'ov.speed': 'Vitesse',
  'ov.addFav': '☆ Ajouter aux favoris',
  'ov.removeFav': '★ Retirer des favoris',
  'ov.share': '🔗 Copier le lien',
  'ov.shareCopied': 'Lien copié',
  'ov.shareFailed': 'Copie impossible — voici le lien : {url}',

  'fav.add': 'Ajouter aux favoris',
  'fav.remove': 'Retirer des favoris',
  'fav.added': '{n} ajouté aux favoris.',
  'fav.removed': '{n} retiré des favoris.',
  'fav.addedMany': '{n} ajoutés aux favoris.',
  'fav.removedMany': '{n} retirés des favoris.',
  'fav.invalid': 'Numéro invalide.',
  'fav.aria': 'Favori {n}',

  'map.onTrain': '🚆 Sur le train',
  'map.wholeRoute': '🧭 Tout le trajet',
  'map.speed': '{kmh} km/h',
  'map.stopped': 'à l’arrêt',
  'map.limit': 'Vitesse maximale de la ligne : {kmh} km/h',
  'signal.libre': 'Voie libre',
  'signal.avertissement': 'Avertissement',
  'signal.semaphore': 'Sémaphore',
  // Deux feux rouges : l'arrêt absolu, que le sémaphore n'impose pas.
  'signal.carre': 'Carré',
  'signal.inconnu': 'Signal inconnu',
  'signal.following': '{n} occupe la section, à {m} m devant',
  'signal.opposing': 'Voie unique : {n} vient en sens inverse, à {m} m',
  'signal.clear': 'Rien devant sur cette ligne',
  'signal.next': 'prochain signal à {m} m',
  'signal.allowed': 'vitesse permise {kmh} km/h',
  'signal.deduced': 'déduit',
  'signal.deducedHelp': 'Aucune source ne publie l’état réel des signaux. Cet aspect est déduit de la position des autres trains et de l’espacement de la ligne.',
  'map.follow': 'Suivre',
  'map.framing': 'Cadrage',
  'map.trainLabel': 'Train suivi',
  'map.disclaimer': 'Position <strong>estimée</strong> : la SNCF ne publie aucune donnée GPS. '
    + "Le train est projeté sur la voie à partir de ses horaires temps réel.",
  'map.absent': 'train absent du flux',

  'jl.trustTitle': 'Peut-on se fier à cette heure ?',
  'jl.changesTitle': 'Ce qui a changé',
  'jl.sourceTitle': "D'où viennent ces informations",
  'conf.confirmed': 'sûre',
  'conf.confirmedTxt': "Le train vient de passer un arrêt : la SNCF vient de confirmer son horaire.",
  'conf.good': 'fiable',
  'conf.goodTxt': "La SNCF a confirmé l'horaire il y a peu. Il ne devrait plus beaucoup bouger.",
  'conf.estimated': 'à surveiller',
  'conf.estimatedTxt': "Le train roule depuis un moment sans passer d'arrêt. Tant qu'il n'en passe "
    + "pas un, la SNCF garde le même retard — il peut donc avoir changé sans que ça se voie.",
  'conf.stale': 'peu sûre',
  'conf.staleTxt': "Long trajet sans arrêt intermédiaire. La SNCF n'a pas revu ce train depuis "
    + "longtemps et reconduit son dernier retard connu : l'heure affichée peut être fausse de "
    + 'plusieurs minutes.',
  'conf.scheduled': 'prévue',
  'conf.scheduledTxt': "Le train n'est pas encore parti : c'est l'horaire prévu.",

  'jl.seenAt': 'vu à',
  'jl.seenAtTxt': "{stop} — le dernier arrêt où la SNCF a effectivement constaté le passage du train.",
  'jl.ago': 'il y a {n} min',
  'jl.twoNumbers': 'deux numéros',
  'jl.twoNumbersTxt': "Cette rame roule accouplée et porte {count} numéros. La SNCF publie des "
    + "horaires différents pour chacun : {list}. Cette page affiche ceux de {shown}, tels quels — "
    + "physiquement c'est pourtant le même train, donc l'un des deux se révélera faux.",
  'jl.firstReading': 'Premier relevé : {delay} de retard.',
  'jl.regained': 'Le train a repris {n} min : retard ramené à {delay}.',
  'jl.lost': 'Le train a perdu {n} min de plus : retard porté à {delay}.',
  'jl.noChange': "Le retard n'a pas bougé depuis que cette page suit le train. C'est normal : "
    + "la SNCF ne réévalue un train qu'à ses arrêts.",
  'jl.schedules': 'horaires',
  'jl.schedulesTxt': 'Les heures affichées viennent du flux temps réel public de la SNCF — '
    + 'ce sont ses prévisions, pas un calcul de notre part.',
  'jl.pastStops': 'arrêts passés',
  'jl.pastStopsTxt': "Ce flux ne publie que des prévisions, y compris pour les arrêts déjà "
    + "franchis : il n'existe aucun champ « heure réelle ». Une gare déjà passée peut donc "
    + "afficher l'heure que la SNCF prévoyait, et non celle où le train est réellement passé.",
  'jl.position': 'position',
  'jl.positionTxt': "Le point sur la carte est calculé, pas mesuré : la SNCF ne diffuse aucune "
    + "position GPS. Le train est placé sur la voie d'après son horaire et la vitesse autorisée "
    + "sur la ligne. À {kmh} km/h, une minute d'écart représente environ {km} km.",
  'jl.goodNews': 'bonne nouvelle',
  'jl.goodNewsTxt': 'Ce train a déjà rattrapé du retard : il a compté jusqu’à {worst} plus tôt '
    + 'sur son parcours, contre {now} maintenant.',

  'banner.offlineTitle': 'Hors ligne — données locales',
  'banner.offlineSub': 'Enregistrées à {time}. Les heures affichées ne bougent plus.',
  'banner.demoTitle': 'Mode démonstration',
  'banner.demoSub': "Flux rejoué depuis une capture, recalé sur l'heure actuelle ({n} trains).",
  'banner.downTitle': 'Flux SNCF indisponible',
  'banner.downSub': 'Aucune donnée temps réel. Nouvelle tentative automatique toutes les 60 s.',
  'banner.frozenSub': 'Données figées à {time} — les heures affichées ne bougent plus.',
  'banner.slowTitle': 'Flux ralenti',
  'banner.slowSub': 'Dernière mise à jour il y a {n} min ({time}).',
  'banner.retry': 'Réessayer',
  'banner.retrying': 'Essai…',
  'banner.restored': 'Flux rétabli : {n} trains.',
  'banner.stillDown': 'Flux toujours indisponible.',

  'alerts.enable': '🔕 Activer les alertes',
  'alerts.enabled': '🔔 Alertes activées',
  'alerts.granted': 'Alertes activées.',
  'alerts.denied': 'Alertes refusées.',
  'alerts.unsupported': 'Notifications non supportées.',
  'alerts.unavailable': 'Notifications indisponibles.',
  'alerts.cancelled': 'Train {n} SUPPRIMÉ',
  'alerts.delayChange': 'Train {n} : {sign}{m} min',
  'alerts.delayBody': '{stop} — désormais {time} (retard {delay})',

  'legend.onTime': "à l'heure",
  'legend.late': 'retard',
  'legend.veryLate': 'fort',
  'error.generic': 'Erreur : {error}',
  'error.badResponse': 'réponse inattendue du serveur',
};

const EN: Dict = {
  'app.title': 'Traincon',
  'app.offline': 'offline',
  'app.localData': 'local data',
  'app.live': 'live',
  'app.minutesAgo': '{n} min',

  'theme.auto': 'Auto',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.group': 'Theme',

  'app.source': 'Source code on GitHub',

  'tab.watch': 'My trains',
  'tab.search': 'Search',
  'tab.worst': 'Hall of shame',

  'worst.title': 'Today’s hall of shame',
  'worst.note': 'The worst delays recorded today, with SNCF’s own reason.',
  'worst.noKey': 'The worst delays recorded today. Without an SNCF API key, reasons are unavailable.',
  'worst.noReason': 'No reason given',
  'worst.running': 'running',
  'worst.finished': 'completed',
  'worst.upcoming': 'not started yet',
  'worst.gone': 'not tracked',
  'worst.empty': 'No notable delays today. It happens.',
  'worst.emptyLive': 'Nothing delayed is running just now.',
  'worst.filterLabel': 'Trains to show',
  'worst.filterAll': 'All',
  'worst.filterLive': 'Running now',
  'worst.failed': 'Hall of shame unavailable: {error}',
  'nav.label': 'Navigation',

  'watch.dormantTag': 'not running',
  'watch.dormantBody': 'Outside the ~8 h forecast window, or not running today.',
  'watch.unknownTag': 'unknown',
  'watch.unknownBody': 'Number {n} does not exist in the timetable.',
  'watch.removeBookmark': 'Remove bookmark',
  'watch.empty.title': 'No trains followed',
  'watch.empty.body': 'Search for your train by number, destination or a station it calls at. '
    + "You'll see its progress live and the real time at your station.",
  'watch.empty.cta': 'Find a train',
  'watch.feedDown': 'Your {n} saved train(s) will reappear once the SNCF feed is back.',

  'search.placeholder': 'Train number, station, destination…',
  'search.label': 'Search for a train',
  'search.clear': 'Clear',
  'search.prompt': 'Type a train number, a station or a destination.',
  'search.none': 'No running train matches “{q}”.',
  'search.feedDown': 'SNCF feed unavailable — nothing to search.',
  'search.results': '{n} result(s)',
  'search.cachedAt': 'local data from {time}',
  'search.failed': 'Search unavailable: {error}',
  'search.filter': 'Filter by type',
  'family.all': 'All',
  'family.tgv': 'TGV',
  'family.ter': 'TER',
  'family.ic': 'Intercités',

  'why.number': 'number',
  'why.destination': 'destination',
  'why.origin': 'origin',
  'why.serves': 'calls at {stop}',
  'search.nextStop': 'next {stop} {time}',

  'delay.onTime': 'on time',
  'delay.minutes': '{sign}{n} min',
  'delay.hours': '{sign}{h} h',
  'delay.hoursMinutes': '{sign}{h} h {m}',
  'delay.cancelled': 'cancelled',
  'delay.cancelledShort': 'CANC.',
  'delay.label': 'delay',

  'trend.worsening': '↗ worsening',
  'trend.recovering': '↘ recovering',
  'trend.stable': '→ stable',

  'countdown.gone': 'gone',
  'countdown.now': 'now',
  'countdown.minutes': 'in {m} min',
  'countdown.hours': 'in {h} h {m}',

  'status.inStation': 'At {stop}',
  'status.notDeparted': 'Not yet departed — due to leave at {time}',
  'status.leavesFor': 'Leaves for {stop} at {time}',
  'status.atPlatform': 'At the platform',
  'status.arrived': 'Arrived at {stop}',
  'status.journeyOver': 'Journey complete',
  'status.between': 'Between {from} and {to}',
  'status.legProgress': '{pct} % of this leg',
  'status.legKm': '{km} km by track',
  'status.speed': '~{kmh} km/h',
  'status.cancelled': 'Train cancelled',
  'status.cancelledSub': "Don't count on this one.",
  'status.unknown': 'Position unknown',

  'pos.notDeparted': 'not yet departed from {stop}',
  'pos.arrived': 'arrived at {stop}',
  'pos.inStation': 'at {stop}',
  'pos.between': 'between {from} and {to} — {pct} % ({km} km)',
  'pos.unknown': 'unknown',

  'card.nextStop': 'Next stop — {stop}',
  'card.arrival': 'Arrives {stop}',
  'card.cancelledWarning': "Don't count on this train.",
  'card.alreadyPassed': 'already passed',
  'stop.departure': 'departs {time}',

  'modal.close': 'Close',
  'mtab.overview': 'Overview',
  'mtab.journey': 'Journey',
  'mtab.map': 'Map',
  'mtab.journal': 'Log',
  'modal.detail': 'Train detail',
  'modal.unknown': 'Train {n} does not exist.',
  'modal.dormant': 'Train {n} is not running right now.',
  'modal.loading': 'Loading…',

  'ov.terminus': 'Terminus',
  'ov.delay': 'Delay',
  'ov.stopsLeft': 'Stops left',
  'ov.outOf': 'of {n}',
  'ov.speed': 'Speed',
  'ov.addFav': '☆ Add to favourites',
  'ov.removeFav': '★ Remove from favourites',
  'ov.share': '🔗 Copy link',
  'ov.shareCopied': 'Link copied',
  'ov.shareFailed': 'Could not copy — here is the link: {url}',

  'fav.add': 'Add to favourites',
  'fav.remove': 'Remove from favourites',
  'fav.added': '{n} added to favourites.',
  'fav.removed': '{n} removed from favourites.',
  'fav.addedMany': '{n} added to favourites.',
  'fav.removedMany': '{n} removed from favourites.',
  'fav.invalid': 'Invalid number.',
  'fav.aria': 'Favourite {n}',

  'map.onTrain': '🚆 On the train',
  'map.wholeRoute': '🧭 Whole route',
  'map.speed': '{kmh} km/h',
  'map.stopped': 'stopped',
  'map.limit': 'Line speed limit: {kmh} km/h',
  'signal.libre': 'Clear',
  'signal.avertissement': 'Caution',
  'signal.semaphore': 'Stop',
  // Kept in French: the two signals are distinct in French practice and the
  // English word "stop" covers both, losing the distinction the icon draws.
  'signal.carre': 'Carré (absolute stop)',
  'signal.inconnu': 'Unknown',
  'signal.following': '{n} is occupying the section, {m} m ahead',
  'signal.opposing': 'Single track: {n} is coming the other way, {m} m off',
  'signal.clear': 'Nothing ahead on this line',
  'signal.next': 'next signal {m} m',
  'signal.allowed': 'permitted {kmh} km/h',
  'signal.deduced': 'deduced',
  'signal.deducedHelp': 'No source publishes real signal states. This aspect is deduced from where the other trains are and how the line is spaced.',
  'map.follow': 'Follow',
  'map.framing': 'Framing',
  'map.trainLabel': 'Tracked train',
  'map.disclaimer': 'Position is <strong>estimated</strong>: SNCF publishes no GPS data. '
    + 'The train is projected onto the track from its real-time schedule.',
  'map.absent': 'train not in the feed',

  'jl.trustTitle': 'How much can this time be trusted?',
  'jl.changesTitle': 'What changed',
  'jl.sourceTitle': 'Where this comes from',
  'conf.confirmed': 'certain',
  'conf.confirmedTxt': 'The train has just called at a stop: SNCF has confirmed its timing.',
  'conf.good': 'reliable',
  'conf.goodTxt': 'SNCF confirmed the timing recently. It should not move much.',
  'conf.estimated': 'watch it',
  'conf.estimatedTxt': 'The train has been running for a while without calling anywhere. Until it '
    + 'does, SNCF keeps the same delay — so it may have changed invisibly.',
  'conf.stale': 'unreliable',
  'conf.staleTxt': 'A long run with no intermediate stop. SNCF has not seen this train for some '
    + 'time and is carrying its last known delay forward: the time shown may be several minutes out.',
  'conf.scheduled': 'scheduled',
  'conf.scheduledTxt': 'The train has not departed yet: this is the timetable.',

  'jl.seenAt': 'seen at',
  'jl.seenAtTxt': '{stop} — the last stop where SNCF actually observed the train passing.',
  'jl.ago': '{n} min ago',
  'jl.twoNumbers': 'two numbers',
  'jl.twoNumbersTxt': 'This rame runs coupled and carries {count} numbers. SNCF publishes '
    + 'different times for each: {list}. This page shows {shown} as-is — yet physically it is one '
    + 'train, so one of the two will turn out to be wrong.',
  'jl.firstReading': 'First reading: {delay} delay.',
  'jl.regained': 'The train made up {n} min: delay down to {delay}.',
  'jl.lost': 'The train lost another {n} min: delay now {delay}.',
  'jl.noChange': 'The delay has not moved since this page started following the train. That is '
    + 'normal: SNCF only reassesses a train at its stops.',
  'jl.schedules': 'schedules',
  'jl.schedulesTxt': "Times come from SNCF's public real-time feed — their forecasts, not our "
    + 'calculation.',
  'jl.pastStops': 'past stops',
  'jl.pastStopsTxt': 'This feed publishes only forecasts, including for stops already passed: '
    + 'there is no "actual time" field at all. A station already behind the train may therefore '
    + 'show the time SNCF expected, not the time it actually went through.',
  'jl.position': 'position',
  'jl.positionTxt': 'The dot on the map is calculated, not measured: SNCF broadcasts no GPS '
    + 'position. The train is placed on the track from its schedule and the line speed limit. '
    + 'At {kmh} km/h, one minute of drift is about {km} km.',
  'jl.goodNews': 'good news',
  'jl.goodNewsTxt': 'This train has already made up time: it was as much as {worst} earlier in '
    + 'the journey, against {now} now.',

  'banner.offlineTitle': 'Offline — local data',
  'banner.offlineSub': 'Saved at {time}. The times shown are frozen.',
  'banner.demoTitle': 'Demo mode',
  'banner.demoSub': 'Replaying a capture, rebased onto the current time ({n} trains).',
  'banner.downTitle': 'SNCF feed unavailable',
  'banner.downSub': 'No real-time data. Retrying automatically every 60 s.',
  'banner.frozenSub': 'Data frozen at {time} — the times shown no longer move.',
  'banner.slowTitle': 'Feed lagging',
  'banner.slowSub': 'Last updated {n} min ago ({time}).',
  'banner.retry': 'Retry',
  'banner.retrying': 'Trying…',
  'banner.restored': 'Feed restored: {n} trains.',
  'banner.stillDown': 'Feed still unavailable.',

  'alerts.enable': '🔕 Enable alerts',
  'alerts.enabled': '🔔 Alerts on',
  'alerts.granted': 'Alerts enabled.',
  'alerts.denied': 'Alerts refused.',
  'alerts.unsupported': 'Notifications not supported.',
  'alerts.unavailable': 'Notifications unavailable.',
  'alerts.cancelled': 'Train {n} CANCELLED',
  'alerts.delayChange': 'Train {n}: {sign}{m} min',
  'alerts.delayBody': '{stop} — now {time} (delay {delay})',

  'legend.onTime': 'on time',
  'legend.late': 'late',
  'legend.veryLate': 'very late',
  'error.generic': 'Error: {error}',
  'error.badResponse': 'unexpected response from the server',
};

export interface Locale {
  name: string;
  dict: Dict;
  intl: string;
}

export const LOCALES: Record<string, Locale> = {
  fr: { name: 'Français', dict: FR, intl: 'fr-FR' },
  en: { name: 'English', dict: EN, intl: 'en-GB' },
};

const FALLBACK = 'fr';

export type TranslateParams = Record<string, string | number>;

/**
 * Translation.
 *
 * The bound helper below is exported as `tr`, never `t`: `t` names a train
 * throughout this codebase, and importing a translator under the same name
 * made every call inside a function binding one resolve to the train instead —
 * a "t is not a function" that no amount of key checking would reveal.
 */
export class I18n {
  private current = FALLBACK;

  /** Best match between the browser's languages and what we ship. */
  static detect(): string {
    const wanted = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
    for (const w of wanted) {
      const base = String(w).toLowerCase().split('-')[0];
      if (base && LOCALES[base]) return base;
    }
    return FALLBACK;
  }

  get lang(): string {
    return this.current;
  }

  /** Locale tag for Intl and toLocaleTimeString. */
  get intlLocale(): string {
    return LOCALES[this.current]?.intl ?? 'fr-FR';
  }

  setLang(lang: string): string {
    this.current = LOCALES[lang] ? lang : FALLBACK;
    document.documentElement.lang = this.current;
    return this.current;
  }

  /**
   * Missing keys fall back to French, then to the key itself — a visible key
   * beats a blank label when a translation is forgotten.
   */
  translate(key: string, params?: TranslateParams): string {
    let s = LOCALES[this.current]?.dict[key] ?? LOCALES[FALLBACK]!.dict[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
    }
    return s;
  }
}

/** The single instance the interface uses. */
export const i18n = new I18n();

/** Bound translator. Always imported as `tr`. */
export const tr = (key: string, params?: TranslateParams): string => i18n.translate(key, params);
