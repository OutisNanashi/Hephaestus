import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertCleanTree, commitTask, createTaskBranch, fixturePr, mergeTask, taskBranchName } from "../src/git-workflow.js";
import { HephaestusError } from "../src/errors.js";
import { writableTemporaryDirectory } from "./helpers/writable-temp.js";

function git(dir,...args) { const r=spawnSync("git",args,{cwd:dir,encoding:"utf8"}); assert.equal(r.status,0,r.stderr); return r.stdout.trim(); }
function repo() { const d=writableTemporaryDirectory("hephaestus-git-"); git(d,"init"); git(d,"config","user.name","Fixture"); git(d,"config","user.email","fixture@local"); fs.writeFileSync(path.join(d,"a.txt"),"a\n"); git(d,"add","a.txt"); git(d,"commit","-m","initial"); return d; }
function code(e,c){assert.ok(e instanceof HephaestusError);assert.equal(e.code,c);return true;}

test("task branches include project and task identity",{concurrency:false},()=>{const d=repo();try{const b=createTaskBranch(d,"demo-project","safe task");assert.equal(b,"hephaestus/demo-project/safe-task");}finally{fs.rmSync(d,{recursive:true,force:true});}});
test("dirty tree blocks branch switch and empty commits",{concurrency:false},()=>{const d=repo();try{fs.writeFileSync(path.join(d,"a.txt"),"b\n");assert.throws(()=>createTaskBranch(d,"demo","task"),e=>code(e,"GIT_DIRTY_TREE"));git(d,"restore","a.txt");assert.throws(()=>commitTask(d,"empty"),e=>code(e,"EMPTY_GIT_COMMIT"));}finally{fs.rmSync(d,{recursive:true,force:true});}});
test("commit metadata and fixture PR metadata are deterministic and merge is refused",{concurrency:false},()=>{const d=repo();try{fs.writeFileSync(path.join(d,"a.txt"),"b\n");const c=commitTask(d,"task change");assert.match(c.hash,/^[0-9a-f]{40}$/u);const open=fixturePr("demo","task");const update=fixturePr("demo","task",open);assert.equal(open.status,"open");assert.equal(update.status,"updated");assert.equal(open.mergeBlocked,true);assert.equal(open.forcePushAllowed,false);assert.throws(()=>mergeTask(),e=>code(e,"MERGE_NOT_AVAILABLE"));}finally{fs.rmSync(d,{recursive:true,force:true});}});
