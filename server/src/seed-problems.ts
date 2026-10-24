// Seeds the problem catalog from LeetCode's public problem list. Run once: `npm run seed:problems`.
import { getDb, upsertProblem } from "./db.js";
import { categoryFromTags } from "./taxonomy.js";

const QUERY = `query list($skip: Int, $limit: Int) {
  problemsetQuestionList: questionList(categorySlug: "", limit: $limit, skip: $skip, filters: {}) {
    total: totalNum
    questions: data { questionFrontendId title titleSlug difficulty isPaidOnly acRate topicTags { slug } }
  }
}`;

interface ListedQuestion {
  questionFrontendId: string;
  title: string;
  titleSlug: string;
  difficulty: string;
  isPaidOnly: boolean;
  acRate: number;
  topicTags: Array<{ slug: string }>;
}

async function fetchPage(skip: number, limit: number) {
  const res = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Referer: "https://leetcode.com/problemset/" },
    body: JSON.stringify({ query: QUERY, variables: { skip, limit } }),
  });
  if (!res.ok) throw new Error(`LeetCode GraphQL ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data: { problemsetQuestionList: { total: number; questions: ListedQuestion[] } } };
  return json.data.problemsetQuestionList;
}

const db = getDb();
const PAGE = 500;
let skip = 0;
let total = Infinity;
while (skip < total) {
  const page = await fetchPage(skip, PAGE);
  total = page.total;
  db.transaction(() => {
    for (const q of page.questions) {
      const tags = q.topicTags.map((t) => t.slug);
      upsertProblem(db, {
        slug: q.titleSlug,
        frontend_id: q.questionFrontendId,
        title: q.title,
        difficulty: q.difficulty,
        tags,
        category: categoryFromTags(tags, q.title),
        paid_only: q.isPaidOnly,
        ac_rate: q.acRate,
      });
    }
  })();
  skip += page.questions.length;
  console.log(`seeded ${skip}/${total}`);
  if (page.questions.length === 0) break;
}
