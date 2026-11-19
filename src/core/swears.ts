/**
 * Swear words in a prompt you write are swapped for mild ones before the
 * agent reads it. Only whole words change: "Scunthorpe", "assess" and
 * "shiitake" stay as written. The case of the swear carries over, so
 * "Fuck" becomes "Flip" and "FUCK" becomes "FLIP".
 */

// Longer forms come first, so "retarded" is never read as "retard" + "ed".
const SWAPS: [string, string][] = [
  ["motherfucking", "mother-flipping"],
  ["motherfucker", "mother-flipper"],
  ["fucking", "flipping"],
  ["fuckin", "flippin"],
  ["fucked", "flipped"],
  ["fucker", "flipper"],
  ["fucks", "flips"],
  ["fuck", "flip"],
  ["retarded", "silly"],
  ["retards", "goofballs"],
  ["retard", "goofball"],
  ["goddamnit", "gosh dang it"],
  ["goddammit", "gosh dang it"],
  ["goddamn", "gosh dang"],
  ["dammit", "dang it"],
  ["damnit", "dang it"],
  ["damned", "danged"],
  ["damn", "dang"],
  ["bullshit", "nonsense"],
  ["shitty", "crappy"],
  ["shits", "craps"],
  ["shit", "crap"],
  ["assholes", "jerks"],
  ["asshole", "jerk"],
  ["jackass", "doofus"],
  ["dumbass", "dummy"],
  ["bitches", "grumps"],
  ["bitching", "griping"],
  ["bitch", "grump"],
  ["bastards", "rascals"],
  ["bastard", "rascal"],
  ["pissed", "ticked"],
  ["piss", "pee"],
  ["cunt", "jerk"],
];

const TO = new Map(SWAPS.map(([from, to]) => [from, to]));
const WORD = new RegExp(`\\b(?:${SWAPS.map(([from]) => from).join("|")})\\b`, "gi");

function withCaseOf(swear: string, word: string): string {
  if (swear === swear.toUpperCase() && swear !== swear.toLowerCase()) return word.toUpperCase();
  if (swear[0] === swear[0]!.toUpperCase()) return word[0]!.toUpperCase() + word.slice(1);
  return word;
}

export function cleanSwears(text: string): string {
  return text.replace(WORD, (swear) => withCaseOf(swear, TO.get(swear.toLowerCase())!));
}
