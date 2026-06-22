import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fail } from "./errors.js";
import { saveState } from "./state.js";

function git(repo, args) { const r=spawnSync("git",args,{cwd:repo,encoding:"utf8"}); if(r.status!==0) fail(r.stderr.trim()||"Git operation failed.","GIT_WORKFLOW_FAILED"); return r.stdout.trim(); }
export function taskBranchName(projectId, task) { const slug=(value)=>value.toLowerCase().replace(/[^a-z0-9]+/gu,"-").replace(/^-|-$/gu,""); if(!slug(projectId)||!slug(task)) fail("Project and task identity are required.","INVALID_GIT_TASK"); return `hephaestus/${slug(projectId)}/${slug(task)}`; }
export function assertCleanTree(repo) { if(git(repo,["status","--porcelain"])!=="") fail("Git worktree is dirty.","GIT_DIRTY_TREE"); }
export function createTaskBranch(repo, projectId, task) { assertCleanTree(repo); const branch=taskBranchName(projectId,task); git(repo,["switch","-c",branch]); return branch; }
export function commitTask(repo, message) { if(git(repo,["status","--porcelain"])==="") fail("Empty commits are forbidden.","EMPTY_GIT_COMMIT"); git(repo,["add","-A"]); git(repo,["commit","-m",message]); return Object.freeze({ hash:git(repo,["rev-parse","HEAD"]), branch:git(repo,["branch","--show-current"]), message }); }
export function fixturePr(projectId, task, existing=null) { const branch=taskBranchName(projectId,task); return Object.freeze({ url:existing?.url??`https://fixture.invalid/${projectId}/pull/${task}`, status:existing?"updated":"open", branch, mergeBlocked:true, forcePushAllowed:false }); }
export function recordGitMetadata(projectPath,state,metadata) { saveState(projectPath,{...state,currentBranch:metadata.branch,currentPr:metadata.url??state.currentPr,mergeStatus:"blocked",lastGptDecision:JSON.stringify({gitMetadata:metadata})}); const out=path.join(projectPath,"out","git"); fs.mkdirSync(out,{recursive:true}); fs.writeFileSync(path.join(out,"metadata.json"),`${JSON.stringify(metadata,null,2)}\n`); fs.appendFileSync(path.join(projectPath,"BUILD_LOG.md"),`\n[phase-6-git] branch=${metadata.branch} commit=${metadata.commit?.hash??"none"} pr=${metadata.url??"none"} mergeBlocked=true\n`); }
export function mergeTask() { fail("Merge is unavailable until a later merge gate.","MERGE_NOT_AVAILABLE"); }
