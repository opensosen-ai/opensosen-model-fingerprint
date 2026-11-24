using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class CodexRpcFixture
{
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static string Setting(string[] args, string key)
    {
        string arg = args.FirstOrDefault(x => x.StartsWith(key + "=", StringComparison.Ordinal));
        return arg == null ? null : Json.Deserialize<string>(arg.Substring(key.Length + 1));
    }

    private static void Emit(object value)
    {
        Console.WriteLine(Json.Serialize(value));
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string control = Environment.GetEnvironmentVariable("FINGERPRINT_FIXTURE_CASE");
        string traceDir = Environment.GetEnvironmentVariable("FINGERPRINT_FIXTURE_TRACE");
        if (!File.Exists(control) || !Directory.Exists(traceDir)) return 2;
        string test = File.ReadAllText(control).Trim();
        string trace = Path.Combine(traceDir, Guid.NewGuid() + ".jsonl");
        string provider = Setting(args, "model_provider");
        string store = Setting(args, "cli_auth_credentials_store");
        string context = store != null ? "storage-" + store : provider == "openai" ? "official" : "configured";
        bool api = test.StartsWith("api-", StringComparison.Ordinal);

        if (args.Contains("exec"))
        {
            string prompt = Console.In.ReadToEnd();
            Match match = Regex.Match(prompt, @"(?<![0-9])(29[2-9]|3[0-2][0-9]|33[0-2])(?![0-9])");
            if (!match.Success) return 2;
            int count = Int32.Parse(match.Groups[1].Value);
            File.AppendAllText(trace, Json.Serialize(new {
                test, context, method = "exec", provider, store, count,
                endpoint = Setting(args, api ? "model_providers.fixture.base_url" : "openai_base_url"),
                ephemeral = args.Contains("--ephemeral"), isolated = args.Contains("--ignore-user-config"),
            }) + Environment.NewLine);
            string raw = String.Join(", ", Enumerable.Range(0, count).Select(i => (i * 71 + count * 13 + i * i * 17) % 355 + 1));
            Emit(new { type = "thread.started", thread_id = Guid.NewGuid().ToString() });
            Emit(new { type = "item.completed", item = new { type = "agent_message", id = "test-message", text = raw } });
            Emit(new { type = "turn.completed" });
            return 0;
        }
        if (args.Contains("--bundled"))
        {
            Emit(new { models = new[] { new { slug = "fixture-model" } } });
            return 0;
        }
        if (!args.Contains("app-server")) return 2;

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            var input = Json.Deserialize<Dictionary<string, object>>(line);
            if (!input.ContainsKey("id")) continue;
            object id = input["id"];
            string method = (string)input["method"];
            object result = null;
            bool fail = false;
            switch (method)
            {
                case "initialize":
                    result = new { userAgent = "codex-fixture/0.171.0" };
                    break;
                case "account/read":
                    fail = context == "configured" && (test == "configured-account-refused" || test == "both-accounts-refused")
                        || context == "official" && (test == "official-account-refused" || test == "both-accounts-refused" || test == "api-official-refused");
                    if (fail && context == "configured") System.Threading.Thread.Sleep(160);
                    object account = api ? (object)new { type = "apiKey" } : new {
                        type = "chatgpt", email = "fixture@example.invalid", planType = "plus", workspaceName = "Fixture",
                    };
                    string identity = (test == "account-conflict" && context == "configured") || test == "account-replaced"
                        ? "other-fixture-account" : "fixture-account";
                    result = new { account, requiresOpenaiAuth = true, userId = identity };
                    break;
                case "modelProvider/list":
                    fail = context == "configured" && test == "configured-provider-refused";
                    if (api && context == "configured")
                    {
                        result = new { defaultProviderId = "fixture", data = new[] {
                            new { id = "fixture", baseUrl = "http://127.0.0.1:12345/v1",
                                settings = new { type = "customGateway", auth = new { mode = "externallyConfigured", envKey = (string)null } } },
                        } };
                    }
                    else
                    {
                        result = new { defaultProviderId = provider == "openai" ? "openai" : "fixture", data = new[] {
                            new { id = "openai", baseUrl = test == "official-route-unconfirmed" ? "https://unconfirmed.invalid/v1" : null,
                                settings = new { type = "openai" } },
                        } };
                    }
                    break;
                case "model/list":
                    fail = context == "official" && test == "official-models-refused";
                    result = new { nextCursor = (string)null, data = new[] {
                        new { model = "fixture-model", displayName = "Fixture model", isDefault = true, inputModalities = new[] { "text" } },
                    } };
                    break;
                default:
                    fail = true;
                    break;
            }
            File.AppendAllText(trace, Json.Serialize(new { test, context, method, rpcCode = fail ? (int?)-32600 : null }) + Environment.NewLine);
            if (fail) Emit(new { id, error = new { code = -32600, message = "fixture error" } });
            else Emit(new { id, result });
        }
        return 0;
    }
}
