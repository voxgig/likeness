/* The binary as a process: what no in-process run can show.
 *
 *   process BIN
 */

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#include "envelope.h"
#include "harness.h"
#include "json.h"

typedef struct {
  int status;
  str out;
  str err;
} proc;

static const char *bin;

static str drain(arena *a, int fd) {
  sbuf b;
  char chunk[4096];
  ssize_t got;
  sb_init(&b, a);
  for (;;) {
    got = read(fd, chunk, sizeof chunk);
    if (got < 0 && EINTR == errno) continue;
    if (got <= 0) break;
    sb_put(&b, chunk, (size_t)got);
  }
  close(fd);
  return sb_done(&b);
}

/* With no reader on stdout at all, the first write is a broken pipe. */
static proc spawn(arena *a, const char *cwd, const char *home, const char *path, const char *const *args,
                  int no_reader) {
  proc r;
  int out[2];
  int err[2];
  pid_t pid;
  int status = 0;
  const char *argv[16];
  char *envp[3];
  size_t i;

  argv[0] = bin;
  for (i = 0; NULL != args[i] && i < 14; i++) argv[i + 1] = args[i];
  argv[i + 1] = NULL;
  {
    sbuf h;
    sbuf p;
    sb_init(&h, a);
    sb_puts(&h, "HOME=");
    sb_puts(&h, home);
    envp[0] = (char *)sb_done(&h).p;
    sb_init(&p, a);
    sb_puts(&p, "PATH=");
    sb_puts(&p, path);
    envp[1] = (char *)sb_done(&p).p;
    envp[2] = NULL;
  }

  if (0 != pipe(out) || 0 != pipe(err)) die("pipe");
  if (no_reader) close(out[0]);
  fflush(stdout);
  pid = fork();
  if (pid < 0) die("fork");
  if (0 == pid) {
    int devnull = open("/dev/null", O_RDONLY);
    if (0 != chdir(cwd)) _exit(126);
    dup2(devnull, 0);
    dup2(out[1], 1);
    dup2(err[1], 2);
    close(devnull);
    if (!no_reader) close(out[0]);
    close(out[1]);
    close(err[0]);
    close(err[1]);
    execve(bin, (char *const *)argv, envp);
    _exit(127);
  }
  close(out[1]);
  close(err[1]);
  r.out = no_reader ? str_mk("", 0) : drain(a, out[0]);
  r.err = drain(a, err[0]);
  while (waitpid(pid, &status, 0) < 0 && EINTR == errno) {
  }
  r.status = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + (WIFSIGNALED(status) ? WTERMSIG(status) : 0);
  return r;
}

/* The child changes directory before it runs the binary. */
static const char *absolute(arena *a, const char *path) {
  char here[4096];
  if ('/' == path[0] || NULL == getcwd(here, sizeof here)) return path;
  return joinpath(a, here, str_of(path));
}

static const char *scratch(arena *a) {
  const char *base = getenv("TMPDIR");
  sbuf b;
  char *dir;
  sb_init(&b, a);
  sb_puts(&b, NULL != base && '\0' != base[0] ? base : "/tmp");
  sb_puts(&b, "/likeness-c-XXXXXX");
  dir = (char *)sb_done(&b).p;
  if (NULL == mkdtemp(dir)) die("mkdtemp");
  return dir;
}

static void write_text(arena *a, const char *dir, const char *name, const char *text) {
  const char *path = joinpath(a, dir, str_of(name));
  FILE *f = fopen(path, "wb");
  if (NULL == f) die("cannot write a scratch file");
  fputs(text, f);
  fclose(f);
}

static void remove_tree(arena *a, const char *dir) {
  pid_t pid = fork();
  int status;
  (void)a;
  if (0 == pid) {
    execl("/bin/rm", "rm", "-rf", "--", dir, (char *)NULL);
    _exit(127);
  }
  if (0 < pid) waitpid(pid, &status, 0);
}

static void expect(tally *t, const char *name, int ok, str detail) {
  if (ok) tap_ok(t, str_of(name));
  else tap_fail(t, str_of(name), detail);
}

static str described(arena *a, proc r) {
  sbuf b;
  sb_init(&b, a);
  sb_puts(&b, "exit ");
  sb_long(&b, r.status);
  sb_puts(&b, "\nstdout ");
  sb_str(&b, r.out);
  sb_puts(&b, "\nstderr ");
  sb_str(&b, r.err);
  return sb_done(&b);
}

static jval *envelope_of(arena *a, proc r) {
  jval *v = NULL;
  if (NULL != json_parse(a, r.out.p, r.out.n, &v) || !jv_is(v, J_OBJECT)) return NULL;
  return v;
}

int main(int argc, char **argv) {
  arena *a = ar_new();
  const char *home;
  const char *bindir;
  tally t;
  proc r;
  jval *env;
  int status;

  if (argc < 2) {
    fprintf(stderr, "usage: process BIN\n");
    return 2;
  }
  bin = absolute(a, argv[1]);
  if (0 != access(bin, X_OK)) {
    fprintf(stderr, "no binary at %s\n", argv[1]);
    return 2;
  }
  memset(&t, 0, sizeof t);
  tap_begin();
  home = scratch(a);

  {
    static const char *const args[] = { "version", "--json", NULL };
    r = spawn(a, home, home, "", args, 0);
    env = envelope_of(a, r);
    expect(&t, "the port runs from a directory with no checkout and an empty HOME",
      0 == r.status && NULL != env && jv_is(jv_getz(env, "ok"), J_TRUE) &&
      str_eqz(field_str(env, "port"), "c") && str_eqz(field_str(jv_getz(env, "data"), "version"), "0.1.0") &&
      0 == r.err.n, described(a, r));
  }

  {
    const char *bad = joinpath(a, home, str_of("bad.json"));
    sbuf eqform;
    sbuf want;
    const char *spaced[5];
    const char *joined[4];
    proc s;
    write_text(a, home, "bad.json", "{not json");
    sb_init(&eqform, a);
    sb_puts(&eqform, "--config=");
    sb_puts(&eqform, bad);
    joined[0] = "list";
    joined[1] = "--json";
    joined[2] = sb_done(&eqform).p;
    joined[3] = NULL;
    spaced[0] = "list";
    spaced[1] = "--json";
    spaced[2] = "--config";
    spaced[3] = bad;
    spaced[4] = NULL;
    sb_init(&want, a);
    sb_puts(&want, "error: invalid-project\n  ");
    sb_puts(&want, bad);
    sb_puts(&want, " is not valid JSON\n  remedy  fix the file, or point --config at another\n");
    r = spawn(a, home, home, "", joined, 0);
    s = spawn(a, home, home, "", spaced, 0);
    expect(&t, "a malformed configuration is refused the same way through both flag forms",
      3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want)) &&
      3 == s.status && 0 == s.out.n && str_eq(s.err, sb_done(&want)), described(a, s));
  }

  {
    const char *dir = joinpath(a, home, str_of("cfg"));
    const char *station;
    const char *args[4];
    sbuf want;
    mkdir(dir, 0700);
    write_text(a, dir, "station.json", "{\"station\":1,\"profiles\":{\"default\":{\"sdk\":{}}}}");
    write_text(a, dir, "likeness.json", "[]");
    station = joinpath(a, dir, str_of("station.json"));
    args[0] = "version";
    args[1] = "--config";
    args[2] = station;
    args[3] = NULL;
    sb_init(&want, a);
    sb_puts(&want, "error: invalid-project\n  ");
    sb_puts(&want, joinpath(a, dir, str_of("likeness.json")));
    sb_puts(&want, " is not a JSON object\n  remedy  fix the file, or point --config at another\n");
    r = spawn(a, home, home, "", args, 0);
    expect(&t, "likeness.json beside the configuration is refused when it is not an object",
      3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want)), described(a, r));

    args[2] = dir;
    r = spawn(a, home, home, "", args, 0);
    sb_init(&want, a);
    sb_puts(&want, "error: invalid-project\n  ");
    sb_puts(&want, dir);
    sb_puts(&want, " cannot be read\n  remedy  fix the file, or point --config at another\n");
    expect(&t, "a configuration that cannot be read as a file is refused, not taken for absent",
      3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want)), described(a, r));
  }

  {
    const char *dir = joinpath(a, home, str_of("cfg2"));
    const char *args[4];
    sbuf want;
    mkdir(dir, 0700);
    mkdir(joinpath(a, dir, str_of("likeness.json")), 0700);
    write_text(a, dir, "station.json", "{\"station\":1,\"profiles\":{\"default\":{\"sdk\":{}}}}");
    args[0] = "version";
    args[1] = "--config";
    args[2] = joinpath(a, dir, str_of("station.json"));
    args[3] = NULL;
    sb_init(&want, a);
    sb_puts(&want, "error: invalid-project\n  ");
    sb_puts(&want, joinpath(a, dir, str_of("likeness.json")));
    sb_puts(&want, " cannot be read\n  remedy  fix the file, or point --config at another\n");
    r = spawn(a, home, home, "", args, 0);
    expect(&t, "likeness.json beside the configuration is refused when it cannot be read as a file",
      3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want)), described(a, r));
  }

  {
    const char *dir = joinpath(a, home, str_of("cfg4"));
    const char *station = joinpath(a, dir, str_of("station.json"));
    const char *likeness = joinpath(a, dir, str_of("likeness.json"));
    const char *args[4];
    sbuf big;
    sbuf want_station;
    sbuf want_likeness;
    proc s;
    proc l;
    proc z;
    mkdir(dir, 0700);
    args[0] = "version";
    args[1] = "--config";
    args[2] = station;
    args[3] = NULL;
    sb_init(&want_station, a);
    sb_puts(&want_station, "error: invalid-project\n  ");
    sb_puts(&want_station, station);
    sb_puts(&want_station, " is not valid JSON\n  remedy  fix the file, or point --config at another\n");
    sb_init(&want_likeness, a);
    sb_puts(&want_likeness, "error: invalid-project\n  ");
    sb_puts(&want_likeness, likeness);
    sb_puts(&want_likeness, " is not valid JSON\n  remedy  fix the file, or point --config at another\n");
    write_text(a, dir, "station.json", "{\"station\":1,\"profiles\":{\"default\":{\"sdk\":{\"joplin\":{\"options\":{\"n\":1e400}}}}}}");
    s = spawn(a, home, home, "", args, 0);
    write_text(a, dir, "station.json", "{\"station\":1,\"profiles\":{\"default\":{\"sdk\":{\"joplin\":{}}}}}");
    write_text(a, dir, "likeness.json", "{\"likeness\":1,\"profiles\":{\"default\":{\"instances\":{\"joplin\":{\"account\":-1e400}}}}}");
    l = spawn(a, home, home, "", args, 0);
    sb_init(&big, a);
    sb_puts(&big, "{\"likeness\":1,\"profiles\":{\"default\":{\"instances\":{\"joplin\":{\"account\":1");
    {
      int k;
      for (k = 0; k < 400; k++) sb_putc(&big, '0');
    }
    sb_puts(&big, "}}}}}");
    write_text(a, dir, "likeness.json", sb_done(&big).p);
    r = spawn(a, home, home, "", args, 0);
    write_text(a, dir, "likeness.json", "{\"likeness\":1,\"profiles\":{\"default\":{\"instances\":{\"joplin\":{\"account\":1e-400}}}}}");
    z = spawn(a, home, home, "", args, 0);
    expect(&t, "a number no double can hold is not valid JSON, in either file, and one too small to hold is zero",
      3 == s.status && 0 == s.out.n && str_eq(s.err, sb_done(&want_station)) &&
      3 == l.status && 0 == l.out.n && str_eq(l.err, sb_done(&want_likeness)) &&
      3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want_likeness)) && 0 == z.status,
      described(a, 0 != z.status ? z : 3 != r.status ? r : 3 != l.status ? l : s));
  }

  {
    const char *dir = joinpath(a, home, str_of("cfg3"));
    const char *station;
    const char *args[4];
    const char *name = "a configuration this process has no permission to read is refused";
    FILE *probe;
    sbuf want;
    mkdir(dir, 0700);
    write_text(a, dir, "station.json", "{\"station\":1,\"profiles\":{\"default\":{\"sdk\":{}}}}");
    station = joinpath(a, dir, str_of("station.json"));
    chmod(station, 0);
    probe = fopen(station, "rb");
    if (NULL != probe) {
      fclose(probe);
      tap_skip(&t, str_of(name), "this process reads a file without permission to, so the refusal cannot be shown here");
    }
    else {
      args[0] = "version";
      args[1] = "--config";
      args[2] = station;
      args[3] = NULL;
      sb_init(&want, a);
      sb_puts(&want, "error: invalid-project\n  ");
      sb_puts(&want, station);
      sb_puts(&want, " cannot be read\n  remedy  fix the file, or point --config at another\n");
      r = spawn(a, home, home, "", args, 0);
      expect(&t, name, 3 == r.status && 0 == r.out.n && str_eq(r.err, sb_done(&want)), described(a, r));
    }
  }

  {
    static const char *const args[] = { "help", NULL };
    r = spawn(a, home, home, "", args, 1);
    expect(&t, "a broken pipe exits quietly with 0", 0 == r.status && 0 == r.err.n, described(a, r));
  }

  {
    static const char *const json[] = { "list", "--json", NULL };
    static const char *const human[] = { "doctor", NULL };
    proc h;
    str message;
    r = spawn(a, home, home, "", json, 0);
    env = envelope_of(a, r);
    message = field_str(jv_getz(env, "error"), "message");
    h = spawn(a, home, home, "", human, 0);
    expect(&t, "a command that waits upstream says so, exit 4, naming the issues",
      4 == r.status && str_eqz(field_str(env, "code"), "unsupported-capability") &&
      str_contains(message, str_of("voxgig/sdkgen#403")) && str_contains(message, str_of("voxgig/sdkgen#405")) &&
      str_contains(message, str_of("voxgig/station#23")) &&
      4 == h.status && 0 == h.out.n && str_starts(h.err, "error: unsupported-capability\n  `doctor` waits"),
      described(a, h));
  }

  bindir = joinpath(a, home, str_of("bin"));
  mkdir(bindir, 0700);
  write_text(a, bindir, "likeness", "");
  write_text(a, bindir, "likeness-ts", "");
  write_text(a, bindir, "likeness-X", "");
  write_text(a, bindir, "likeness-", "");
  write_text(a, bindir, "other", "");
  mkdir(joinpath(a, bindir, str_of("likeness-go")), 0700);
  if (0 != symlink("likeness-ts", joinpath(a, bindir, str_of("likeness-rb")))) die("symlink");
  {
    static const char *const args[] = { "which", "--json", NULL };
    sbuf path;
    sbuf want;
    jval *data;
    str rendered;
    sb_init(&path, a);
    sb_puts(&path, bindir);
    sb_puts(&path, ":");
    sb_puts(&path, bindir);
    sb_puts(&path, "/:/nonexistent::");
    r = spawn(a, home, home, sb_done(&path).p, args, 0);
    env = envelope_of(a, r);
    data = jv_getz(env, "data");
    sb_init(&want, a);
    sb_puts(&want, "[{\"path\":\"");
    sb_puts(&want, bindir);
    sb_puts(&want, "/likeness\",\"port\":\"\",\"version\":\"\"},{\"path\":\"");
    sb_puts(&want, bindir);
    sb_puts(&want, "/likeness-rb\",\"port\":\"rb\",\"version\":\"\"},{\"path\":\"");
    sb_puts(&want, bindir);
    sb_puts(&want, "/likeness-ts\",\"port\":\"ts\",\"version\":\"\"}]");
    expect(&t, "which reads each binary's port from its name, once per path, files alone",
      0 == r.status && NULL != data && 0 == lk_render(a, data, &rendered, NULL) && str_eq(rendered, sb_done(&want)),
      described(a, r));

    r = spawn(a, home, home, "", args, 0);
    env = envelope_of(a, r);
    expect(&t, "which with nothing on PATH names this port, not on PATH",
      0 == r.status && NULL != env && 0 == lk_render(a, jv_getz(env, "data"), &rendered, NULL) &&
      str_eqz(rendered, "[{\"path\":\"(this port, not on PATH)\",\"port\":\"c\",\"version\":\"0.1.0\"}]"),
      described(a, r));
  }

  {
    static const char *const args[] = { "help", "\xe2\x82", "--json", NULL };
    r = spawn(a, home, home, "", args, 0);
    env = envelope_of(a, r);
    expect(&t, "an argument that is not UTF-8 is read as the canonical port reads it",
      3 == r.status && str_eqz(field_str(jv_getz(env, "error"), "message"),
        "<command> takes a name ([a-z][a-z0-9-]*), not \"\xef\xbf\xbd\""), described(a, r));
  }

  remove_tree(a, home);
  status = tap_end(&t);
  ar_free(a);
  return status;
}
