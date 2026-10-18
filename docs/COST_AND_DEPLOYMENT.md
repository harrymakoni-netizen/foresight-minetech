# Development resources and release boundaries

No purchases, production deployments, real mine record changes or external notifications were made.

| Resource | Actual use / known requirement | Price |
| --- | --- | --- |
| Text model | No provider configured; zero live provider calls | Unpriced until provider/model chosen |
| Simulator | Local Python CPU; measured three-node/six-pump 24h fixture ≈83 ms, 8640 substeps (see numerical-evaluation.json) | Local/runtime hosting unpriced |
| Vision | ONNX Runtime CPU installed; mathematical adapter/decoded-video smoke executed; no pretrained PPE weights or camera processed | Model/export licence and hosting unpriced |
| Reconstruction | No capture, GPU training or asset supplied | Compute and capture unpriced |
| Database | Development SQLite on persistent local disk; no hosted database provisioned | Hosted transactional service unpriced |
| Evidence storage | Fictional development records and small generated test artifacts; raw clip/evidence paths are local and ignored | Binary storage/retention pricing unpriced |
| Notifications | No delivered SMS, USSD or emergency callbacks | Outside core release |

Runtime hardware/platform and numerical timings are recorded by the verification script. Vision 5 FPS / p95 <2s targets are unmeasured on an approved PPE model and real source. No universal low-cost performance or safety-accuracy claim is made. Bundle measurements, when run, are in `docs/browser-verification.json`; initial non-map reporting JavaScript budget is 350 KiB gzip, excluding lazy 3D.

A competition demonstration runs only fictional workspaces with disclosed missing inputs. A supervised evaluation additionally requires reviewed model/data licences, representative clips/text labels, predetermined accuracy targets, checked geometry and practitioner/engineering review. Operational release requires site-specific measured inputs, validated policies and models, access/account lifecycle, incident procedures and an independently accepted deployment architecture. The development demonstration is not an operational mine pilot.

No institutional endorsement, mentoring, field pilot or engineering sign-off is recorded. Maintain genuine support documentation separately; studying at an institution does not establish its endorsement.

## Hosted persistence follow-up

PostgreSQL/Supabase-compatible code and Vercel Python compute are implemented and tested on local PostgreSQL 17. Vercel authentication/compute secrets were configured; the existing private Blob store was inspected for metadata only. An attempt to create/connect a separate private store failed on the existing token-name conflict; no second store is relied on. New uploads use a scoped folder in the existing private store, without modifying old records. The user connected Supabase through the installed integration. Its PostgreSQL migrations and synthetic hosted workflow checks now pass. No paid plan upgrade was requested or performed. See [HOSTED_SETUP.md](HOSTED_SETUP.md).
