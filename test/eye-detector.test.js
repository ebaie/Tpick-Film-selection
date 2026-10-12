const { test } = require('node:test');
const assert = require('node:assert/strict');
const eye = require('../lib/eye-detector');
const model = require('../models/eye_ensemble_6f.json');

function landmarks(width, height, angle, opening = 0.2) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
  const c = Math.cos(angle), s = Math.sin(angle);
  const coord = (x, y, cx) => ({ x: (cx + x * c - y * s) / width, y: (height / 2 + x * s + y * c) / height });
  for (const [indices, cx] of [[[33,133,159,145,160,144,158,153],width*.35],[[263,362,386,374,387,373,385,380],width*.65]]) {
    const points = [[-20,0],[20,0],[0,-20*opening],[0,20*opening],[-6,-20*opening],[-6,20*opening],[6,-20*opening],[6,20*opening]];
    indices.forEach((index,i) => lm[index] = coord(...points[i],cx));
  }
  return lm;
}

test('openness is invariant to portrait/landscape normalization, scale and head roll', () => {
  for (const [width,height] of [[1024,680],[680,1024],[1024,1024]]) for (const angle of [-.8,-.2,0,.2,.8]) {
    const lm = landmarks(width,height,angle);
    for (const side of ['L','R']) {
      const geometry=eye.geometry(lm,width,height,side);
      assert.ok(Math.abs(geometry.openness-.2)<1e-12);
      assert.ok(Math.abs(geometry.span-40)<1e-10);
      const scaled=eye.geometry(lm,width/2,height/2,side);
      assert.ok(Math.abs(scaled.openness-.2)<1e-12);
    }
  }
});

test('horizontal crop orientation for either endpoint order and bounds after rotation', () => {
  const lm=landmarks(680,1024,.65);
  const before=eye.geometry(lm,680,1024,'R');
  [lm[263],lm[362]]=[lm[362],lm[263]];
  const after=eye.geometry(lm,680,1024,'R');
  assert.ok(Math.abs(before.angle-after.angle)<1e-12);
  const box=eye.cropBox(after,680,1024,1.7);
  assert.equal(box.inFrame,true);
  assert.ok(Math.abs(box.h/box.w-.6)<1e-12);
  assert.equal(eye.cropBox({...after,cx:1},680,1024,1.7).inFrame,false);
});

test('missing, nonfinite and degenerate landmarks do not mean closed eyes', () => {
  assert.equal(eye.geometry([],680,1024,'L'),null);
  const lm=landmarks(680,1024,0);
  lm[33].x=NaN;
  assert.equal(eye.geometry(lm,680,1024,'L'),null);
  lm[33]=lm[133];
  assert.equal(eye.geometry(lm,680,1024,'L'),null);
  assert.equal(eye.isClosed({p:1,reliable:false},.65),false);
  assert.equal(eye.isClosed({p:null},.65),false);
});

test('calibrated fusion preserves OPEN-vs-CLOSED probability direction', () => {
  eye.validateModel(model);
  const open=[.01,.02,.3,.32,.99,.98], closed=[.7,.8,.04,.05,.05,.01];
  assert.ok(eye.predict(open,model)<.2);
  assert.ok(eye.predict(closed,model)>.88);
  for(let i=0;i<6;i++) {
    const altered=open.slice(); altered[i]+=.05;
    const delta=eye.predict(altered,model)-eye.predict(open,model);
    assert.ok(i<2 ? delta>=-1e-12 : delta<=1e-12);
  }
  assert.throws(()=>eye.validateModel({...model,coef:[...model.coef.slice(0,3),.5,...model.coef.slice(4)]}));
  assert.throws(()=>eye.validateModel({...model,features:model.features.slice().reverse()}));
});

test('a visible open eye protects winks; conflicting or missing results need review', () => {
  assert.equal(eye.clearlyOpen({L:.01,R:.8},{L:.3,R:.03},{L:[.99,.99,.99],R:[.01,.02,.01]}),true);
  assert.equal(eye.clearlyOpen({L:.7,R:.8},{L:.03,R:.04},{L:[.01,.02,.01],R:[.01,.02,.01]}),false);
  assert.equal(eye.isClosed({p:.99,reliable:true,bothClosedEligible:false},.65),false);
  assert.equal(eye.decision({p:.99,reliable:true,bothClosedEligible:false},.88),'conflict');
  assert.equal(eye.decision({p:.65,reliable:true},.88),'review');
  assert.equal(eye.decision({p:null,reliable:false,status:'no-face'},.88),'no-face');
});

test('changing thresholds recomputes cached probabilities in either direction', () => {
  const cached={p:.85,threshold:.88,reliable:true,bothClosedEligible:true};
  assert.equal(eye.isClosed(cached,.88),false);
  assert.equal(eye.isClosed(cached,.78),true);
  assert.equal(eye.isClosed(cached,.93),false);
  assert.equal(cached.threshold,.88);
});

test('paired eye evidence protects an open eye even when the crop classifier disagrees', () => {
  const wink = eye.eyeEvidence(.04, .3, [.03, .06, .02]);
  assert.equal(wink.open, true);
  assert.equal(wink.closed, false);
  assert.equal(eye.isClosed({ p: .98, reliable: true, bothClosedEligible: false, closedSupported: false }, .88), false);
  assert.equal(eye.isClosed({ p: .98, reliable: true, closedSupported: false }, .88), false);
  assert.equal(eye.isClosed({ p: .8, reliable: true, bothClosedEligible: true, closedSupported: true }, .88), true);
});

test('ambiguous crops and low fusion scores with closure evidence require review', () => {
  const ambiguous = eye.eyeEvidence(.2, .2, [.01, .99, .5]);
  assert.equal(ambiguous.unstable, true);
  assert.equal(ambiguous.open, false);
  assert.equal(ambiguous.closed, false);
  const closed = eye.eyeEvidence(.7, .05, [.04, .03, .02]);
  const open = eye.eyeEvidence(.02, .3, [.98, .96, .99]);
  assert.equal(eye.decision({ p: .08, reliable: true, evidence: { L: closed, R: open } }, .88), 'review');
  assert.equal(eye.eyeEvidence(.36,.3,[.009,.019,.008]).closed,false,'a visible eyelid gap must not be overridden by the crop classifier');
  assert.equal(eye.eyeEvidence(.23,.257,[.11,.02,.45]).closed,true,'weak but consistent eyelid evidence should support closure');
});

test('group photos rejudge each face and keep unknown or capped faces in review', () => {
  const open = { p: .05, reliable: true };
  const closed = { p: .79, reliable: true, bothClosedEligible: true, closedSupported: true };
  const group = { faces: [open, closed] };
  assert.equal(eye.decision(group, .88), 'closed');
  assert.equal(eye.decision(group, .78), 'closed');
  assert.equal(eye.isClosed(group, .78), true);
  assert.equal(eye.isClosed(group, .93), false);
  assert.equal(eye.decision({ faces: [open, { p: null, reliable: false, status: 'small-eyes' }] }, .88), 'review');
  assert.equal(eye.decision({ faces: [open], faceLimitReached: true }, .88), 'review');
  assert.equal(eye.decision({ faces: [open, open] }, .88), 'open');
});

test('face refinement region clips to the source image and rejects invalid meshes', () => {
  const region = eye.faceRegion(landmarks(680,1024,0), 680, 1024);
  assert.ok(region && region.x >= 0 && region.y >= 0 && region.x + region.w <= 680 && region.y + region.h <= 1024);
  assert.equal(eye.faceRegion([],680,1024), null);
  assert.equal(eye.faceRegion([{x:NaN,y:.5}],680,1024), null);
});
