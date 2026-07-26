/**
 * Populates a demo graph so the 3D view has something to show before you've
 * talked to it. Safe to run once; refuses to overwrite an existing brain
 * unless you pass --force.
 *
 *   npm run seed
 *   npm run seed -- --force
 */
import * as store from '../server/store.js';
import * as memory from '../server/memory.js';
import { config } from '../server/config.js';

const NODES = [
  ['You', 'person', 'The owner of this second brain.', 0.95],
  ['Portuguese', 'project', 'Learning European Portuguese, aiming for B1 by spring.', 0.8],
  ['Ana', 'person', 'Portuguese tutor. Lessons Tuesdays at 7pm over video.', 0.7],
  ['Anki', 'source', 'Spaced-repetition app used for Portuguese vocabulary drills.', 0.45],
  ['Kyoto trip', 'event', 'Two weeks in Kyoto in April, timed for the cherry blossoms.', 0.65],
  ['Ryokan booking', 'task', 'Still need to book a ryokan for the Arashiyama nights.', 0.6],
  ['Sourdough starter', 'project', 'A starter named Bubbles, fed at 8am daily.', 0.5],
  ['Bubbles', 'entity', 'The sourdough starter itself. Three years old, very reliable.', 0.4],
  ['Deep work mornings', 'preference', 'No meetings before 11am. Mornings are for focused work.', 0.85],
  ['Espresso', 'preference', 'Double ristretto, no sugar. Never after 2pm.', 0.5],
  ['Atlas', 'project', 'This knowledge graph — a second brain that talks back.', 0.9],
  ['Graph databases', 'concept', 'Storing knowledge as nodes and edges rather than rows.', 0.6],
  ['Embeddings', 'concept', 'Dense vectors that place similar meanings near each other.', 0.6],
  ['Spaced repetition', 'concept', 'Reviewing material at widening intervals to fight forgetting.', 0.55],
  ['Memory palace', 'concept', 'Placing ideas in imagined space to make them easier to recall.', 0.5],
  ['Why 3D?', 'question', 'Does spatial layout actually help recall, or does it just look good?', 0.45],
  ['Cherry blossoms', 'concept', 'Sakura. Peak bloom in Kyoto is usually the first week of April.', 0.35],
  ['Marta', 'person', 'Friend in Lisbon. Offered a place to stay for a language immersion week.', 0.55],
  ['Lisbon', 'entity', 'Where Marta lives, and the likely destination for immersion practice.', 0.5],
  ['Immersion week', 'task', 'Plan a week in Lisbon once conversational confidence is higher.', 0.5],
];

const LINKS = [
  ['You', 'learning', 'Portuguese', 0.9],
  ['Ana', 'teaches', 'Portuguese', 0.95],
  ['Portuguese', 'practised_with', 'Anki', 0.7],
  ['Anki', 'implements', 'Spaced repetition', 0.85],
  ['You', 'planning', 'Kyoto trip', 0.85],
  ['Kyoto trip', 'requires', 'Ryokan booking', 0.9],
  ['Kyoto trip', 'timed_for', 'Cherry blossoms', 0.8],
  ['You', 'maintains', 'Sourdough starter', 0.7],
  ['Sourdough starter', 'named', 'Bubbles', 0.95],
  ['You', 'prefers', 'Deep work mornings', 0.9],
  ['You', 'prefers', 'Espresso', 0.7],
  ['Espresso', 'supports', 'Deep work mornings', 0.5],
  ['You', 'building', 'Atlas', 0.95],
  ['Atlas', 'built_on', 'Graph databases', 0.8],
  ['Atlas', 'built_on', 'Embeddings', 0.8],
  ['Atlas', 'inspired_by', 'Memory palace', 0.6],
  ['Memory palace', 'raises', 'Why 3D?', 0.7],
  ['Atlas', 'raises', 'Why 3D?', 0.6],
  ['Graph databases', 'relates_to', 'Embeddings', 0.5],
  ['Memory palace', 'relates_to', 'Spaced repetition', 0.45],
  ['Marta', 'lives_in', 'Lisbon', 0.9],
  ['You', 'friend_of', 'Marta', 0.75],
  ['Immersion week', 'located_in', 'Lisbon', 0.85],
  ['Portuguese', 'advanced_by', 'Immersion week', 0.8],
  ['Marta', 'offered', 'Immersion week', 0.7],
];

const force = process.argv.includes('--force');

await store.load();
const existing = store.stats();

if (existing.nodes > 0 && !force) {
  console.log(`\n  Refusing to seed: ${existing.nodes} memories already exist.`);
  console.log('  Run "npm run seed -- --force" to add the demo graph anyway.\n');
  process.exit(0);
}

console.log(`\n  Seeding ${NODES.length} memories into ${store.dataFile()}…`);

const { created, merged, edges } = await memory.remember({
  nodes: NODES.map(([label, type, summary, importance]) => ({ label, type, summary, importance })),
  links: LINKS.map(([from, rel, to, weight]) => ({ from, rel, to, weight })),
});

await store.flush();

console.log(`  ${created.length} created, ${merged.length} merged, ${edges.length} links.`);
console.log(`  Embeddings: ${config.openai.apiKey ? 'OpenAI' : 'local fallback'}.`);
console.log('\n  Run "npm run dev" and open http://localhost:5173\n');
process.exit(0);
