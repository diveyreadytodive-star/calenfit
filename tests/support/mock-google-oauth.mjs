if (process.env.MOCK_GOOGLE_OAUTH === "1") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    if (url?.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      return new Response(
        JSON.stringify({
          items: [{
            id: "e2e-google-event",
            status: "confirmed",
            summary: "Google 연결 면접",
            description: "Google Calendar에서 동기화한 채용 면접",
            start: { dateTime: "2026-09-21T10:00:00+09:00" },
            end: { dateTime: "2026-09-21T11:00:00+09:00" },
          }],
          nextSyncToken: "e2e-next-sync-token",
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
    if (url === "https://api.groq.com/openai/v1/chat/completions") {
      const requestBody = JSON.parse(init?.body || "{}");
      const input = requestBody.messages?.at(-1)?.content || "";
      const isExam = /시험|응시/.test(input);
      const isSports = /수영|운동/.test(input);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: isExam ? "exam" : isSports ? "sports" : "general", confidence: 0.91, rationale: "일정 의도를 구조화했습니다.", evidenceCandidates: isExam ? ["응시확인서"] : [], intentTags: isExam ? ["자격시험 응시"] : isSports ? ["수영 강습"] : ["일반 일정"], policyDomains: isExam ? ["exam"] : isSports ? ["sports"] : ["general"] }) } }] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (url === "https://api.groq.com/openai/v1/models") return new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    return originalFetch(input, init);
  };
}
