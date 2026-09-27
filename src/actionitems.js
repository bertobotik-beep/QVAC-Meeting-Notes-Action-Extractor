// QVAC Meeting Notes Action Extractor — core logic.
// completion() pulls out ONLY concrete action items from raw notes, one
// per line prefixed with "- ". The one-shot example is real multi-turn
// history (not prose in the system prompt) so the model is much less
// likely to parrot it verbatim regardless of the real notes. Grounding
// is reinforced with an explicit "never invent" rule and a fallback that
// never fabricates a task if none can be confidently parsed.

import { completion } from "@qvac/sdk";

function looksUnusable(line) {
  if (!line || line.trim().length === 0) return true;
  if (line.length > 200) return true;
  const bad = ["i cannot", "i can't", "as an ai", "i'm not able", "no action items"];
  const lower = line.toLowerCase();
  return bad.some((phrase) => lower.includes(phrase));
}

const EXAMPLE_NOTES =
  "quick sync on the launch. we agreed the landing page copy is final. " +
  "priya will update the pricing table by friday. still need someone to test " +
  "the checkout flow on mobile before we ship. jordan is going to send the " +
  "press release draft to the team tomorrow.";
const EXAMPLE_OUTPUT = `- Update the pricing table by Friday (Priya)
- Test the checkout flow on mobile before shipping
- Send the press release draft to the team tomorrow (Jordan)`;

// A second few-shot pair demonstrating the "nothing to extract" case —
// notes that are just a recap of a casual conversation, with no future
// task anyone committed to. Small models otherwise tend to invent an
// "action item" out of whatever topics were merely discussed (e.g. "talked
// about the team lunch" becomes a fabricated task "Discuss the team
// lunch"). Showing this as a real assistant turn, not a prose rule, is a
// much stronger signal than instructions alone.
const EXAMPLE_NOTES_2 =
  "casual catch up, nothing urgent on the agenda. chatted about how the " +
  "offsite went last month and how busy everyone's been. no decisions, no " +
  "new work assigned.";
const EXAMPLE_OUTPUT_2 = "- No action items found.";

// Individual example bullet lines, used to strip any of them out verbatim
// if the model parrots the one-shot example instead of (or alongside) the
// real notes — this is checked unconditionally, regardless of what the
// real notes say, since an exact match to the example is always suspect.
const EXAMPLE_ITEMS = EXAMPLE_OUTPUT
  .split("\n")
  .map((l) => l.replace(/^-\s*/, "").trim().toLowerCase())
  // Also guard a formatting illustration that used to live in the system
  // prompt's prose (e.g. "update the roadmap doc (sarah)") — small models
  // can latch onto even an inline prose example, so it's blocklisted here
  // as defense in depth even after being removed from the prompt text.
  .concat(["update the roadmap doc (sarah)"]);

// Heuristic drop-list: lines that are clearly a negation/recap rather than
// a future task someone is going to do (small models sometimes bullet
// these anyway, e.g. turning "no decisions made" into its own "item").
const NON_ACTION_PATTERNS = [
  /^no (decisions?|new tasks?|action items?)/i,
  /^(nothing|none)\b/i,
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "with", "to", "in", "on", "at",
  "is", "it", "this", "that", "we", "our", "about", "from", "how", "went",
]);

function words(str) {
  return str
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

// Phrases like "talked about the team lunch" or "reminisced about last
// quarter" describe something that already happened — a past discussion
// topic, not a future task. A small model sometimes rephrases exactly
// that noun phrase into a fabricated "action item" (e.g. "Discuss the
// team lunch"). Extracting these topic phrases from the source notes lets
// us deterministically drop any generated item that's really just one of
// them wearing a task-shaped verb.
function extractPastTopics(notes) {
  const re = /(?:talked about|chatted about|discussed|reminisced about|caught up on|recapped)\s+([^.,;\n]+)/gi;
  const topics = [];
  let m;
  while ((m = re.exec(notes)) !== null) topics.push(m[1]);
  return topics;
}

function isRehashedPastTopic(item, pastTopicWordSets) {
  const itemWords = words(item);
  if (itemWords.length === 0) return false;
  return pastTopicWordSets.some((topicWords) => {
    if (topicWords.length === 0) return false;
    const shared = itemWords.filter((w) => topicWords.includes(w));
    return shared.length > 0;
  });
}

// Sentences that state something is already finalized/decided (e.g. "we
// agreed the pricing page copy is final") describe a DECISION, not a task.
// A small model sometimes borrows the noun phrase from a decision sentence
// and bolts on a deadline/owner from a neighboring sentence, fabricating a
// task that was never actually assigned. Extracting the decision sentence's
// own words lets us drop any generated item that's really just that noun
// phrase wearing someone else's deadline.
function extractDecisionSentences(notes) {
  // Deliberately narrow: only sentences explicitly framed as an already-
  // settled decision ("is final", "is decided"). A broader trigger like
  // bare "we agreed" would also catch genuine commitments phrased as "we
  // agreed [person] would do X", which ARE real action items.
  return notes
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /\bis (final|decided)\b|\bwas decided\b/i.test(s));
}

// Cross-check that a claimed owner name actually appears in the same source
// sentence as the task's own words. The model sometimes borrows an owner
// name from a neighboring sentence about a different task (e.g. "Sarah will
// finalize X" bleeding onto an unrelated "we agreed to hold off on Y" line).
// Rather than pattern-matching every possible decision phrasing, this checks
// the claim directly: if the name isn't in any sentence that shares real
// content words with the item, the attribution is almost certainly
// misattributed, so strip the owner tag instead of dropping the whole item.
function stripMisattributedOwner(item, notes) {
  const ownerMatch = item.match(/^(.*)\s\(([^)]+)\)$/);
  if (!ownerMatch) return item;
  const [, task, owner] = ownerMatch;
  const taskWords = words(task);
  const sentences = notes.split(/(?<=[.!?])\s+/);
  const ownerLower = owner.toLowerCase();
  const supportingSentence = sentences.some((s) => {
    if (!s.toLowerCase().includes(ownerLower)) return false;
    const sentenceWords = words(s);
    return taskWords.some((w) => sentenceWords.includes(w));
  });
  return supportingSentence ? item : task.trim();
}

function parseItems(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("-"))
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter((l) => l.length > 0 && !looksUnusable(l));
}

export async function extract(modelId, notes) {
  const run = completion({
    modelId,
    history: [
      {
        role: "system",
        content:
          "You extract action items from raw, messy meeting notes. An action item " +
          "is a concrete FUTURE task someone is going to do — not a topic that was " +
          "merely discussed, recapped, or reminisced about. Find EVERY distinct action " +
          "item mentioned anywhere in the notes — do not skip any, and do not stop " +
          'after just one. Output ONLY a bullet list, one action item per line ' +
          'starting with "- ". Add the owner\'s name in parentheses at the end of the ' +
          "line ONLY if a name is explicitly mentioned for that specific task, and " +
          "omit the parentheses entirely if no owner is mentioned. Only use " +
          "tasks that are literally described in the notes given to you right now — " +
          "never invent a task, owner, or deadline that isn't there, and never reuse a " +
          "task from a different conversation. Never combine details from two different " +
          "sentences into one item — a deadline or owner belongs only to the specific " +
          "task named in the same sentence as it, never to an unrelated decision or " +
          "task nearby. A statement that something 'is final' or 'is decided' is a " +
          "decision, not an action item, even if a deadline appears in a nearby " +
          "sentence. If the notes are just a recap or casual chat with no future task " +
          'committed to, output exactly: - No action items found.',
      },
      { role: "user", content: EXAMPLE_NOTES },
      { role: "assistant", content: EXAMPLE_OUTPUT },
      { role: "user", content: EXAMPLE_NOTES_2 },
      { role: "assistant", content: EXAMPLE_OUTPUT_2 },
      { role: "user", content: notes },
    ],
    stream: true,
    completionOpts: { temperature: 0.15, maxTokens: 400 },
  });

  let text = "";
  for await (const token of run.tokenStream) text += token;

  let items = parseItems(text);

  // Guard against the model parroting a one-shot example line verbatim —
  // drop any parsed item that's an exact match to one of the example's
  // bullets, regardless of what the real notes say (an exact match is
  // always suspect, since it would be an extraordinary coincidence).
  items = items.filter((i) => !EXAMPLE_ITEMS.includes(i.toLowerCase()));

  // Drop anything that's clearly a negation/recap statement rather than a
  // real task (e.g. the model bulleting "No decisions made, no new tasks").
  items = items.filter((i) => !NON_ACTION_PATTERNS.some((re) => re.test(i.trim())));

  // Drop anything that's really just a past discussion topic rephrased as
  // a task (see isRehashedPastTopic above).
  const pastTopicWordSets = extractPastTopics(notes).map(words);
  items = items.filter((i) => !isRehashedPastTopic(i, pastTopicWordSets));

  // Drop anything that's really a finalized decision's noun phrase wearing
  // a deadline/owner borrowed from a different sentence.
  const decisionWordSets = extractDecisionSentences(notes).map(words);
  items = items.filter((i) => !isRehashedPastTopic(i, decisionWordSets));

  // Drop any owner name that isn't actually supported by the sentence the
  // task itself came from (see stripMisattributedOwner above).
  items = items.map((i) => stripMisattributedOwner(i, notes));

  const noneFound = items.length === 0 || (items.length === 1 && /no action items/i.test(items[0]));

  return {
    actionItems: noneFound ? ["No action items found in the notes."] : items,
  };
}
