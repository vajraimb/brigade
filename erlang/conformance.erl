#!/usr/bin/env escript
%% -*- erlang -*-
%%! -noshell
%%
%% Kernel semantic dump for BRIGADE vs OTP 29.1.
%% Prints one `id<TAB>got` line per case, same strings as
%% `src/lib/actor/semantics.ts` OTP_IDS.  Byte-identical TSV is the
%% conformance claim.
%%
%%     escript erlang/conformance.erl
%%     npm run conform          # dumps brigade; diffs if escript is on PATH

-module(conformance).
-mode(compile).
-export([main/1,
         init/1, handle_call/3, handle_cast/2, handle_info/2,
         terminate/2, code_change/3]).

main(_) ->
    Cases = [
        {"spawn", fun spawn_case/0},
        {"send-receive", fun send_receive/0},
        {"fifo", fun fifo/0},
        {"selective-receive", fun selective_receive/0},
        {"mailbox-dies", fun mailbox_dies/0},
        {"drop-dead", fun drop_dead/0},
        {"link-cascade", fun link_cascade/0},
        {"normal-no-cascade", fun normal_no_cascade/0},
        {"trap-exit", fun trap_exit_case/0},
        {"system-message", fun system_message/0},
        {"kill-untrappable", fun kill_untrappable/0},
        {"unlink-isolates", fun unlink_isolates/0},
        {"exit-pid", fun exit_pid_case/0},
        {"monitor-down", fun monitor_down/0},
        {"monitor-noproc", fun monitor_noproc/0},
        {"demonitor-flush", fun demonitor_flush/0},
        {"demonitor-leaves", fun demonitor_leaves/0},
        {"gs-call", fun gs_call/0},
        {"gs-call-crash", fun gs_call_crash/0},
        {"gs-cast", fun gs_cast/0}
    ],
    lists:foreach(
      fun({Id, F}) ->
              Got = try lists:flatten(F())
                    catch C:R:St ->
                        io:format(standard_error,
                                  "FAIL ~s: ~p:~p~n~p~n",
                                  [Id, C, R, St]),
                        "error"
                    end,
              io:format("~s\t~s~n", [Id, Got])
      end,
      Cases).

%% ── format: must match TypeScript `show()` ──────────────────────

fmt_term({'EXIT', _Pid, Reason}) -> "EXIT " ++ fmt_term(Reason);
fmt_term({'DOWN', _Ref, process, _Pid, Reason}) -> "DOWN " ++ fmt_term(Reason);
fmt_term(A) when is_atom(A) -> atom_to_list(A);
fmt_term(I) when is_integer(I) -> integer_to_list(I);
fmt_term(L) when is_list(L) -> L;
fmt_term(Other) -> lists:flatten(io_lib:format("~p", [Other])).

fmt_list(List) ->
    "[" ++ lists:flatten(lists:join(", ", [fmt_term(X) || X <- List])) ++ "]".

wait_exit(Pid) ->
    M = erlang:monitor(process, Pid),
    receive
        {'DOWN', M, process, Pid, Reason} -> Reason
    after 2000 ->
        error({still_alive, Pid})
    end.

wait_until(Pred) -> wait_until(Pred, 400).

wait_until(_Pred, 0) -> error(timeout);
wait_until(Pred, N) ->
    case Pred() of
        true -> ok;
        false -> receive after 5 -> wait_until(Pred, N - 1) end
    end.

mail_has(Pid, Pred) ->
    case erlang:process_info(Pid, messages) of
        {messages, Msgs} -> lists:any(Pred, Msgs);
        _ -> false
    end.

%% ── kernel cases ────────────────────────────────────────────────

spawn_case() ->
    Pid = spawn(fun() -> receive after infinity -> ok end end),
    case {is_process_alive(Pid), erlang:process_info(Pid, messages)} of
        {true, {messages, []}} -> "true";
        _ -> "false"
    end.

send_receive() ->
    Parent = self(),
    Pong = spawn(fun() -> receive M -> Parent ! {got, M} end end),
    Pong ! hi,
    receive {got, M} -> fmt_term(M) end.

fifo() ->
    Parent = self(),
    Box = spawn(fun() ->
        Parent ! {ready, self()},
        receive go -> ok end,
        Got = [receive T -> T end || _ <- [1, 2, 3]],
        Parent ! {got, Got}
    end),
    BoxPid = receive {ready, B} -> B end,
    [BoxPid ! T || T <- [a, b, c]],
    wait_until(fun() ->
        {message_queue_len, 3} =:= erlang:process_info(BoxPid, message_queue_len)
    end),
    BoxPid ! go,
    receive {got, Got} -> fmt_list(Got) end.

selective_receive() ->
    Parent = self(),
    Box = spawn(fun() ->
        Parent ! {ready, self()},
        receive go -> ok end,
        receive grill -> ok end,
        {messages, Msgs} = erlang:process_info(self(), messages),
        Parent ! {got, Msgs},
        receive after infinity -> ok end
    end),
    BoxPid = receive {ready, B} -> B end,
    [BoxPid ! T || T <- [fry, grill, pass, grill, fry]],
    wait_until(fun() ->
        {message_queue_len, 5} =:= erlang:process_info(BoxPid, message_queue_len)
    end),
    BoxPid ! go,
    receive {got, Msgs} -> fmt_list(Msgs) end.

mailbox_dies() ->
    Pid = spawn(fun() -> receive after infinity -> ok end end),
    Pid ! fry,
    Pid ! grill,
    exit(Pid, kill),
    wait_exit(Pid),
    case erlang:process_info(Pid, messages) of
        undefined -> "dead []";
        {messages, M} -> "alive " ++ fmt_list(M)
    end.

drop_dead() ->
    Parent = self(),
    Dead = spawn(fun() -> ok end),
    wait_exit(Dead),
    Src = spawn(fun() -> Dead ! late, Parent ! sent, receive after infinity -> ok end end),
    receive sent -> ok end,
    case is_process_alive(Src) andalso (not is_process_alive(Dead)) of
        true -> "1";
        false -> "0"
    end.

link_cascade() ->
    Parent = self(),
    A = spawn(fun() ->
        B = spawn_link(fun() ->
            Parent ! {b, self()},
            receive after infinity -> ok end
        end),
        Parent ! {a, self(), B},
        receive after infinity -> ok end
    end),
    {APid, BPid} = receive {a, A0, B0} -> {A0, B0} end,
    receive {b, _} -> ok end,
    exit(APid, kill),
    wait_exit(APid),
    wait_exit(BPid),
    Alive = length([P || P <- [APid, BPid], is_process_alive(P)]),
    integer_to_list(Alive).

normal_no_cascade() ->
    Parent = self(),
    A = spawn(fun() ->
        B = spawn_link(fun() ->
            Parent ! {b, self()},
            receive go -> ok end
        end),
        Parent ! {a, self()},
        receive after infinity -> ok end
    end),
    APid = receive {a, A0} -> A0 end,
    BPid = receive {b, B0} -> B0 end,
    BPid ! go,
    Reason = wait_exit(BPid),
    Live = case is_process_alive(APid) of true -> "A alive"; false -> "A dead" end,
    Live ++ ", B " ++ fmt_term(Reason).

trap_exit_case() ->
    Parent = self(),
    Sup = spawn(fun() ->
        process_flag(trap_exit, true),
        W = spawn_link(fun() -> receive after infinity -> ok end end),
        Parent ! {w, W},
        receive {'EXIT', W, Reason} -> Parent ! {reason, Reason} end,
        receive after infinity -> ok end
    end),
    W = receive {w, W0} -> W0 end,
    exit(W, kill),
    Reason = receive {reason, R} -> R end,
    fmt_term(Reason) ++ " " ++ atom_to_list(is_process_alive(Sup)).

system_message() ->
    Parent = self(),
    Box = spawn(fun() ->
        process_flag(trap_exit, true),
        W = spawn_link(fun() -> receive after infinity -> ok end end),
        Parent ! {ready, self(), W},
        receive go -> ok end,
        receive fry -> ok end,
        {messages, Msgs} = erlang:process_info(self(), messages),
        Parent ! {got, Msgs},
        receive after infinity -> ok end
    end),
    {BoxPid, W} = receive {ready, B, W0} -> {B, W0} end,
    BoxPid ! grill,
    exit(W, kill),
    wait_until(fun() ->
        mail_has(BoxPid, fun({'EXIT', _, _}) -> true; (_) -> false end)
    end),
    BoxPid ! fry,
    BoxPid ! go,
    receive {got, Msgs} -> fmt_list(Msgs) end.

kill_untrappable() ->
    Parent = self(),
    A = spawn(fun() ->
        Parent ! {a, self()},
        B = spawn(fun() ->
            process_flag(trap_exit, true),
            Parent ! {b, self()},
            receive after infinity -> ok end
        end),
        receive go -> exit(B, kill) end,
        receive after infinity -> ok end
    end),
    APid = receive {a, A0} -> A0 end,
    BPid = receive {b, B0} -> B0 end,
    M = erlang:monitor(process, BPid),
    APid ! go,
    BReason = receive {'DOWN', M, process, BPid, R} -> R end,
    Live = case is_process_alive(APid) of true -> "A alive"; false -> "A dead" end,
    Live ++ ", B " ++ fmt_term(BReason).

unlink_isolates() ->
    Parent = self(),
    A = spawn(fun() ->
        Parent ! {a, self()},
        B = spawn_link(fun() ->
            Parent ! {b, self()},
            receive after infinity -> ok end
        end),
        unlink(B),
        receive after infinity -> ok end
    end),
    APid = receive {a, A0} -> A0 end,
    BPid = receive {b, B0} -> B0 end,
    exit(BPid, kill),
    wait_exit(BPid),
    Live = case is_process_alive(APid) of true -> "A alive"; false -> "A dead" end,
    Dead = case is_process_alive(BPid) of true -> "alive"; false -> "dead" end,
    Live ++ ", B " ++ Dead.

exit_pid_case() ->
    Parent = self(),
    A = spawn(fun() ->
        Parent ! {a, self()},
        B = spawn(fun() ->
            Parent ! {b, self()},
            receive after infinity -> ok end
        end),
        receive go -> exit(B, shutdown) end,
        receive after infinity -> ok end
    end),
    APid = receive {a, A0} -> A0 end,
    BPid = receive {b, B0} -> B0 end,
    APid ! go,
    wait_exit(BPid),
    Left = case is_process_alive(APid) of true -> "alive"; false -> "dead" end,
    Right = case is_process_alive(BPid) of true -> "alive"; false -> "dead" end,
    Left ++ " " ++ Right.

monitor_down() ->
    Parent = self(),
    A = spawn(fun() ->
        B = spawn(fun() -> receive after infinity -> ok end end),
        Ref = erlang:monitor(process, B),
        Parent ! {ready, self(), B},
        receive {'DOWN', Ref, process, _, Reason} ->
            Parent ! {got, Reason, self()}
        end,
        receive after infinity -> ok end
    end),
    {_APid, B} = receive {ready, A0, B0} -> {A0, B0} end,
    exit(B, kill),
    receive {got, Reason, AlivePid} ->
        Live = case is_process_alive(AlivePid) of
                   true -> "A alive";
                   false -> "A dead"
               end,
        "DOWN " ++ fmt_term(Reason) ++ " · " ++ Live
    end.

monitor_noproc() ->
    Ghost = spawn(fun() -> ok end),
    wait_exit(Ghost),
    Ref = erlang:monitor(process, Ghost),
    receive
        {'DOWN', Ref, process, _, Reason} -> fmt_term(Reason)
    end.

demonitor_flush() ->
    Parent = self(),
    A = spawn(fun() ->
        B = spawn(fun() -> receive after infinity -> ok end end),
        Ref = erlang:monitor(process, B),
        Parent ! {ready, self(), B, Ref},
        receive go -> ok end,
        erlang:demonitor(Ref, [flush]),
        {messages, Msgs} = erlang:process_info(self(), messages),
        Parent ! {got, Msgs},
        receive after infinity -> ok end
    end),
    {APid, B, _Ref} = receive {ready, A0, B0, R} -> {A0, B0, R} end,
    exit(B, kill),
    wait_until(fun() ->
        mail_has(APid, fun({'DOWN', _, _, _, _}) -> true; (_) -> false end)
    end),
    APid ! go,
    receive {got, Msgs} -> fmt_list(Msgs) end.

demonitor_leaves() ->
    Parent = self(),
    A = spawn(fun() ->
        B = spawn(fun() -> receive after infinity -> ok end end),
        Ref = erlang:monitor(process, B),
        Parent ! {ready, self(), B, Ref},
        receive go -> ok end,
        erlang:demonitor(Ref),
        {messages, Msgs} = erlang:process_info(self(), messages),
        Parent ! {got, Msgs},
        receive after infinity -> ok end
    end),
    {APid, B, _Ref} = receive {ready, A0, B0, R} -> {A0, B0, R} end,
    exit(B, kill),
    wait_until(fun() ->
        mail_has(APid, fun({'DOWN', _, _, _, _}) -> true; (_) -> false end)
    end),
    APid ! go,
    receive {got, Msgs} -> fmt_list(Msgs) end.

%% ── gen_server (real OTP behaviour, same module) ────────────────

init([]) -> {ok, []}.

handle_call(ping, _From, S) -> {reply, pong, S};
handle_call(seen, _From, S) -> {reply, S, S};
handle_call(Other, _From, S) -> {reply, Other, S}.

handle_cast(nudge, S) -> {noreply, S ++ [nudge]};
handle_cast(_Req, S) -> {noreply, S}.

handle_info(_Info, S) -> {noreply, S}.
terminate(_Reason, _S) -> ok.
code_change(_Old, S, _Extra) -> {ok, S}.

gs_call() ->
    {ok, Pid} = gen_server:start(?MODULE, [], []),
    Reply = gen_server:call(Pid, ping),
    gen_server:stop(Pid),
    fmt_term(Reply).

gs_call_crash() ->
    Parent = self(),
    Server = spawn(fun() ->
        receive
            {'$gen_call', _From, _Req} ->
                Parent ! ready,
                receive after infinity -> ok end
        end
    end),
    Client = spawn(fun() ->
        Parent ! {client, self()},
        Result = (catch gen_server:call(Server, ping, 5000)),
        Parent ! {result, Result}
    end),
    receive {client, CPid} -> ok end,
    receive ready -> ok end,
    exit(Server, kill),
    receive {result, Result} ->
        Reason = case Result of
                     {'EXIT', killed} -> killed;
                     {'EXIT', {killed, _}} -> killed;
                     {'EXIT', R} -> R;
                     Other -> Other
                 end,
        Live = case is_process_alive(CPid) of
                   true -> "client alive";
                   false -> "client dead"
               end,
        fmt_term(Reason) ++ " · " ++ Live
    end.

gs_cast() ->
    {ok, Pid} = gen_server:start(?MODULE, [], []),
    ok = gen_server:cast(Pid, nudge),
    Seen = gen_server:call(Pid, seen),
    gen_server:stop(Pid),
    fmt_list(Seen).
