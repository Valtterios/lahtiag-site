// Per-event questions: what the board can ask, and how a form's answers
// are checked. No SQL here (db.ts).

export const QUESTION_KINDS = ['text', 'choice', 'checkbox'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export interface EventQuestionRow {
  id: number;
  event_id: number;
  label: string;
  kind: QuestionKind;
  options: string | null; // choice: one per line
  required: number;
  sort: number;
}

export const QUESTION_LIMITS = { label: 80, options: 600, answer: 300, perEvent: 8 } as const;

export function questionOptions(q: Pick<EventQuestionRow, 'options'>): string[] {
  return (q.options ?? '')
    .split('\n')
    .map((o) => o.trim())
    .filter((o) => o !== '');
}

export type AnswerErrors = { question: EventQuestionRow; problem: 'required' | 'invalid' }[];

// Form fields are named q<id>, or <prefix><id> when one form carries the
// answers of several tickets (x1_q<id>, x2_q<id>). Checkboxes arrive as
// "on" or not at all; choices must be one of the options; text is
// trimmed and capped.
export function parseAnswers(
  questions: EventQuestionRow[],
  form: FormData,
  prefix = 'q',
): { ok: true; answers: Map<number, string> } | { ok: false; errors: AnswerErrors } {
  const answers = new Map<number, string>();
  const errors: AnswerErrors = [];
  for (const q of questions) {
    const raw = form.get(`${prefix}${q.id}`);
    if (q.kind === 'checkbox') {
      const on = raw === 'on';
      if (q.required && !on) errors.push({ question: q, problem: 'required' });
      answers.set(q.id, on ? 'yes' : '');
      continue;
    }
    const value = String(raw ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, QUESTION_LIMITS.answer);
    if (value === '') {
      if (q.required) errors.push({ question: q, problem: 'required' });
      answers.set(q.id, '');
      continue;
    }
    if (q.kind === 'choice' && !questionOptions(q).includes(value)) {
      errors.push({ question: q, problem: 'invalid' });
      continue;
    }
    answers.set(q.id, value);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, answers };
}

// Whether a person's stored answers satisfy every required question.
export function answersComplete(questions: EventQuestionRow[], answers: Map<number, string> | undefined): boolean {
  return questions.every((q) => !q.required || (answers?.get(q.id) ?? '') !== '');
}
