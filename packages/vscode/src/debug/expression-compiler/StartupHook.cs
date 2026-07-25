using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;

// The .NET host looks for this exact namespace-free type when the assembly is
// loaded through DOTNET_STARTUP_HOOKS.
public static class StartupHook
{
    private sealed record InitializeRequest(string Project, string Prefabs);

    private sealed record CompileRequest(
        int Id,
        string Kind,
        string Name,
        string Code,
        string[] Locals,
        string[] Globals
    );

    private sealed record Response(
        bool Ok,
        int? Id = null,
        string? Bytes = null,
        int Errors = 0,
        string? Message = null,
        string? Log = null
    );

    public static void Initialize()
    {
        var protocolOut = Console.Out;
        var protocolError = Console.Error;
        using var captured = new StringWriter();
        CompilerSession? session = null;
        try
        {
            Console.SetOut(captured);
            Console.SetError(captured);
            var initializeLine = Console.In.ReadLine()
                ?? throw new InvalidOperationException("Missing expression compiler initialization.");
            var initialize = JsonSerializer.Deserialize<InitializeRequest>(initializeLine)
                ?? throw new InvalidOperationException("Invalid expression compiler initialization.");
            session = CompilerSession.Start(initialize);
            WriteResponse(protocolOut, new Response(true));

            string? line;
            while ((line = Console.In.ReadLine()) is not null)
            {
                captured.GetStringBuilder().Clear();
                CompileRequest? request = null;
                try
                {
                    request = JsonSerializer.Deserialize<CompileRequest>(line)
                        ?? throw new InvalidOperationException("Invalid expression compiler request.");
                    WriteResponse(protocolOut, session.Compile(request));
                }
                catch (Exception error)
                {
                    WriteResponse(
                        protocolOut,
                        ErrorResponse(error, request?.Id, captured.ToString())
                    );
                }
            }
        }
        catch (Exception error)
        {
            WriteResponse(protocolOut, ErrorResponse(error, null, captured.ToString()));
        }
        finally
        {
            session?.Dispose();
            Console.SetOut(protocolOut);
            Console.SetError(protocolError);
        }
        Environment.Exit(0);
    }

    private static Response ErrorResponse(Exception error, int? id, string log)
    {
        var actual = error;
        while (actual is TargetInvocationException && actual.InnerException is not null)
        {
            actual = actual.InnerException;
        }
        return new Response(false, id, Message: actual.Message, Log: log);
    }

    private static void WriteResponse(TextWriter output, Response response)
    {
        output.WriteLine(JsonSerializer.Serialize(response));
        output.Flush();
    }

    private sealed class CompilerSession : IDisposable
    {
        private readonly Type programType;

        private CompilerSession(Type programType)
        {
            this.programType = programType;
        }

        public static CompilerSession Start(InitializeRequest request)
        {
            Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
            var compilerAssembly = Assembly.GetEntryAssembly()
                ?? throw new InvalidOperationException("GMAssetCompiler assembly is not loaded.");
            var directory = Path.GetDirectoryName(compilerAssembly.Location)
                ?? throw new InvalidOperationException("GMAssetCompiler directory is unavailable.");
            var fileIoAssembly = Assembly.LoadFrom(Path.Combine(directory, "FileIO.dll"));
            var coreAssembly = Assembly.LoadFrom(Path.Combine(directory, "CoreResources.dll"));
            var programType = compilerAssembly.GetType("GMAssetCompiler.Program", true)!;

            InvokeStatic(
                fileIoAssembly.GetType("YoYoStudio.Resources.FileIO", true)!,
                "SetDefaultFileFunctions"
            );
            InvokeStatic(
                coreAssembly.GetType("YoYoStudio.Resources.MessageIO", true)!,
                "SetDefaultMessageFunctions"
            );
            InvokeStatic(
                programType,
                "InitializeLicencesModuleForOptions",
                BindingFlags.NonPublic | BindingFlags.Static
            );

            var projectInfo = coreAssembly.GetType("YoYoStudio.Resources.ProjectInfo", true)!;
            InvokeStatic(projectInfo, "Init", arguments: [request.Prefabs]);
            var resourceInfo = coreAssembly.GetType("YoYoStudio.Resources.ResourceInfo", true)!;
            InvokeStatic(resourceInfo, "FindAllResources");
            InvokeStatic(resourceInfo, "FindAllResourceAdapters");

            var projectType = coreAssembly.GetType("YoYoStudio.Resources.GMProject", true)!;
            var project = InvokeStatic(
                projectType,
                "LoadProjectBasic",
                arguments: [request.Project, true]
            ) ?? throw new InvalidOperationException("GameMaker could not load the project.");
            InvokeStatic(programType, "InitSession", arguments: [project, request.Project]);
            return new CompilerSession(programType);
        }

        public Response Compile(CompileRequest request)
        {
            var locals = MakeStringList(request.Locals);
            var globals = MakeStringList(request.Globals);
            var methodName = request.Kind == "statement"
                ? "CompileStatement"
                : "CompileExpression";
            var result = InvokeStatic(
                programType,
                methodName,
                arguments: [request.Name, request.Code, locals, globals]
            ) ?? throw new InvalidOperationException("GameMaker returned no compiler result.");
            var resultType = result.GetType();
            var stream = (MemoryStream?)resultType.GetProperty("Key")?.GetValue(result)
                ?? throw new InvalidOperationException("GameMaker returned no VM bytecode.");
            var errors = (int)(resultType.GetProperty("Value")?.GetValue(result) ?? 0);
            var bytes = stream.ToArray();
            if (errors > 0)
            {
                return new Response(
                    false,
                    request.Id,
                    Errors: errors,
                    Message: DecodeCompilerError(bytes)
                );
            }
            return new Response(
                true,
                request.Id,
                Convert.ToBase64String(bytes)
            );
        }

        public void Dispose()
        {
            InvokeStatic(programType, "QuitSession");
        }
    }

    private static object MakeStringList(IEnumerable<string> values)
    {
        var type = typeof(List<>).MakeGenericType(typeof(string));
        var list = (IList)Activator.CreateInstance(type)!;
        foreach (var value in values)
        {
            list.Add(value);
        }
        return list;
    }

    private static string DecodeCompilerError(byte[] bytes)
    {
        if (bytes.Length < 4)
        {
            return Encoding.UTF8.GetString(bytes).TrimEnd('\0', '\r', '\n');
        }
        var length = BitConverter.ToInt32(bytes, 0);
        if (length > 0 && length <= bytes.Length - 4)
        {
            return Encoding.UTF8
                .GetString(bytes, 4, length)
                .TrimEnd('\0', '\r', '\n');
        }
        return Encoding.UTF8.GetString(bytes).TrimEnd('\0', '\r', '\n');
    }

    private static object? InvokeStatic(
        Type type,
        string name,
        BindingFlags flags = BindingFlags.Public | BindingFlags.Static,
        object?[]? arguments = null
    )
    {
        var candidates = type
            .GetMethods(flags)
            .Where(method => method.Name == name)
            .Where(method => method.GetParameters().Length == (arguments?.Length ?? 0))
            .ToArray();
        var method = candidates.Length == 1
            ? candidates[0]
            : throw new MissingMethodException(type.FullName, name);
        return method.Invoke(null, arguments);
    }
}
