export type Citation = {
  title: string;
  url: string;
};

export type ChatRequest = {
  question: string;
};

export type ChatResponse = {
  answer: string;
  citations: Citation[];
};

