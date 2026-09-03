if (process.env.MOCK_ADVERSARIAL_AI === "1") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input?.url;

    if (url === "https://api.groq.com/openai/v1/chat/completions") {
      const requestBody = JSON.parse(init?.body || "{}");
      const promptInput = String(requestBody.messages?.at(-1)?.content || "");

      if (/정보처리기사 실기 원서 접수/.test(promptInput)) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "sports",
                confidence: 1.7,
                rationale: "잘못된 분류를 일부러 반환합니다.",
                evidenceCandidates: ["응시확인서"],
                intentTags: ["기사 시험 접수"],
                policyDomains: ["invalid-domain"],
              }),
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }

      if (/필라테스 체험 수업/.test(promptInput)) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: `analysis:${JSON.stringify({
                type: "general",
                confidence: 0.77,
                rationale: "운동 체험 일정으로 해석했습니다.",
                evidenceCandidates: ["수업 신청 캡처"],
                intentTags: ["필라테스 수업"],
                policyDomains: ["sports", "unknown-domain"],
              })}`,
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }

      if (/원룸 계약금 송금/.test(promptInput)) {
        return new Response(JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                type: "general",
                confidence: 0.66,
                rationale: "주거 관련 일정입니다.",
                evidenceCandidates: ["계좌이체 내역"],
                intentTags: ["주거 계약"],
                policyDomains: [],
              }),
            },
          }],
        }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      }
      if (/설명회 참석/.test(promptInput)) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "general", confidence: 0.8, rationale: "직무 교육 설명회", evidenceCandidates: [], intentTags: ["직무 교육 수강"], policyDomains: ["education"] }) } }] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "general", confidence: 0.7, rationale: "테스트 기본 응답", evidenceCandidates: [], intentTags: [], policyDomains: ["general"] }) } }] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    if (url === "https://api.groq.com/openai/v1/models") return new Response(JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });

    return originalFetch(input, init);
  };
}
