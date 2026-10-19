// Shared public source fixtures for the hook and app-server harnesses.
export default [
  {
    "type": "webSearch",
    "id": "search-empty",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [],
    "durationMs": 15
  },
  {
    "type": "webSearch",
    "id": "search-structured",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [
      {
        "title": "Fixture docs",
        "url": "https://example.test/docs",
        "snippet": "Actual snippet"
      }
    ],
    "durationMs": 25
  },
  {
    "type": "webSearch",
    "id": "search-text",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [
      "Exact reported text\nsecond line"
    ],
    "durationMs": 30
  },
  {
    "type": "webSearch",
    "id": "search-unparsed",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": "not JSON: exact output"
  },
  {
    "type": "webSearch",
    "id": "search-opaque",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [
      {
        "opaque": {
          "answer": 42
        }
      },
      {
        "title": "Docs",
        "url": "https://example.test"
      },
      "tail text"
    ]
  },
  {
    "type": "webSearch",
    "id": "search-queries",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": null,
      "queries": [
        "first actual query",
        "second actual query"
      ]
    },
    "results": []
  },
  {
    "type": "webSearch",
    "id": "search-extended",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [],
    "mode": "extended",
    "durationMs": 11
  },
  {
    "type": "webSearch",
    "id": "search-null-results",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": null
  },
  {
    "type": "webSearch",
    "id": "search-no-query",
    "query": "",
    "action": {
      "type": "search",
      "query": null,
      "queries": null
    },
    "results": []
  },
  {
    "type": "webSearch",
    "id": "search-failure",
    "query": "fixture query",
    "action": {
      "type": "search",
      "query": "actual query",
      "queries": null
    },
    "results": [
      "provider failed"
    ],
    "status": "failed",
    "error": {
      "message": "provider failure"
    }
  },
  {
    "type": "webSearch",
    "id": "open-full",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Actual page text",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "find-full",
    "query": "fixture query",
    "action": {
      "type": "findInPage",
      "url": "https://example.test/docs",
      "pattern": "actual \"pattern\""
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Reported matching excerpt",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "open-http-failure",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": [
      {
        "bytes": 123,
        "code": 404,
        "codeText": "Not Found",
        "result": "Actual 404 body",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ],
    "status": "failed"
  },
  {
    "type": "webSearch",
    "id": "open-missing",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": [
      "Only page text"
    ]
  },
  {
    "type": "webSearch",
    "id": "find-missing",
    "query": "fixture query",
    "action": {
      "type": "findInPage",
      "url": "https://example.test/docs",
      "pattern": "needle"
    },
    "results": [
      "Only matches"
    ]
  },
  {
    "type": "webSearch",
    "id": "open-null-url",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": null
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Actual page text",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "find-null-pattern",
    "query": "fixture query",
    "action": {
      "type": "findInPage",
      "url": "https://example.test/docs",
      "pattern": null
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Actual page text",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "open-mismatched-url",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://other.test"
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Actual page text",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "open-code-zero",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": [
      {
        "bytes": 123,
        "code": 0,
        "codeText": "OK",
        "result": "Actual page text",
        "durationMs": 12,
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "open-no-duration",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": [
      {
        "bytes": 123,
        "code": 200,
        "codeText": "OK",
        "result": "Actual page text",
        "url": "https://example.test/docs"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "web-other",
    "query": "fixture query",
    "action": {
      "type": "other"
    },
    "results": [
      {
        "actual": "opaque action"
      }
    ]
  },
  {
    "type": "webSearch",
    "id": "web-future",
    "query": "fixture query",
    "action": {
      "type": "futureAction",
      "payload": {
        "exact": true
      }
    },
    "results": [
      "actual future output"
    ]
  },
  {
    "type": "webSearch",
    "id": "open-transport-failure",
    "query": "fixture query",
    "action": {
      "type": "openPage",
      "url": "https://example.test/docs"
    },
    "results": null,
    "status": "failed",
    "error": {
      "message": "connection refused"
    }
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-host-present",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-absent",
    "server": "absent",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-unknown-contract",
    "server": "parity_fixture",
    "tool": "unknown",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-mismatched-server",
    "server": "parity-fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-account-memory",
    "server": "memory",
    "tool": "memory_search",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-reserved-tool",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options",
      "tool": "collision"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-reserved-tool_use_id",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options",
      "tool_use_id": "collision"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-reserved-agentId",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options",
      "agentId": "collision"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-reserved-consent",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options",
      "consent": "collision"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-reserved-requestMeta",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options",
      "requestMeta": "collision"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual MCP output"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-structured",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [],
      "structuredContent": {
        "answer": 42,
        "data": "literal data field"
      },
      "_meta": {
        "trace": "kept"
      }
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-media",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "image",
          "mimeType": "image/png",
          "data": "IMAGE_BYTES"
        },
        {
          "type": "audio",
          "mimeType": "audio/wav",
          "data": "AUDIO_BYTES"
        }
      ],
      "structuredContent": {
        "answer": 42
      },
      "_meta": {
        "trace": "kept"
      }
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-resource",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "resource",
          "resource": {
            "uri": "fixture://file",
            "mimeType": "application/octet-stream",
            "blob": "RESOURCE_BYTES"
          }
        },
        {
          "type": "resource_link",
          "uri": "fixture://link",
          "name": "Fixture link"
        }
      ],
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-failed",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "failed",
    "result": null,
    "error": {
      "message": "Actual MCP failure"
    },
    "durationMs": 8
  },
  {
    "type": "mcpToolCall",
    "id": "mcp-result-error",
    "server": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "result": {
      "content": [
        {
          "type": "text",
          "text": "Actual tool error"
        }
      ],
      "isError": true,
      "structuredContent": null,
      "_meta": null
    },
    "error": null,
    "durationMs": 8
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-host-present",
    "namespace": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputText",
        "text": "Actual dynamic output"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-null-namespace",
    "namespace": null,
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputText",
        "text": "Actual dynamic output"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-mismatch",
    "namespace": "parity-fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputText",
        "text": "Actual dynamic output"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-reserved",
    "namespace": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "tool": "Bash",
      "agentId": "spoof"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputText",
        "text": "Actual dynamic output"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-image",
    "namespace": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputImage",
        "imageUrl": "data:image/png;base64,DYNAMIC_IMAGE"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-audio",
    "namespace": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "completed",
    "contentItems": [
      {
        "type": "inputAudio",
        "audioUrl": "data:audio/wav;base64,DYNAMIC_AUDIO"
      }
    ],
    "success": true,
    "durationMs": 4
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic-failed",
    "namespace": "parity_fixture",
    "tool": "lookup",
    "arguments": {
      "topic": "options"
    },
    "status": "failed",
    "contentItems": [
      {
        "type": "inputText",
        "text": "Actual dynamic output"
      }
    ],
    "success": false,
    "durationMs": 4
  }
]
