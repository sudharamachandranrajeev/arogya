# Arogya: EHR Feature Inventory (clean-room, public sources)

Date: 2026-10-24. Scope: outpatient clinics, GP practices, community health first (v0.x); hospital inpatient later.

## 0. Method, rules, caveats

- Built only from public marketing pages, public docs, press coverage and general public domain knowledge of the field. All descriptions are in own words. No code, schema, screenshot or long text copied. No binary reverse engineering.
- Source-quality note: a number of vendor feature claims below come from search-result summaries of vendor pages, trade press (Fierce, Becker's, TechTarget, Healthcare IT News) and third-party blogs. Where a feature attribution rests on general industry knowledge rather than a page actually opened in this research, it is marked `(gk)`. Treat `(gk)` rows as "widely known, verify before citing".
- Vendor-reported statistics (minutes saved, accuracy) are claims, not measurements. None are used for requirements.
- Source conflicts noted: OpenEMR certification edition/date differs between sources; Epic interface counts differ between its own pages; ADL 2 maturity differs between openEHR sources. Do not cite those figures.

### System key (used in "Who" column)

| Code | System |
|---|---|
| EP | Epic (Hyperspace, MyChart, Art/AI) |
| OR | Oracle Health (Cerner Millennium, new cloud ambulatory EHR) |
| MT | MEDITECH Expanse |
| AT | athenahealth (athenaOne) |
| EC | eClinicalWorks (healow) |
| NG | NextGen (Enterprise / Office) |
| EM | EMIS Web (UK) |
| TP | TPP SystmOne (UK) |
| OE | OpenEMR |
| OM | OpenMRS |
| BA | Bahmni |
| GH | GNU Health |
| MH | Marley Health / Frappe Healthcare |
| HR | HospitalRun (archived) |
| OH | openEHR (spec ecosystem, not a product) |
| MP | Medplum |
| D2 | DHIS2 Tracker / Android Capture |

### Priority key

- P0 = must exist in first outpatient/community release.
- P1 = soon after (v0.3 to v0.6) or needed by many real clinics.
- P2 = later (inpatient era, specialty, advanced).

### Source URLs consulted (global)

- https://open.epic.com/Home/Interoperate , https://open.epic.com/Home/Explore , https://open.epic.com/Scheduling/FHIR , https://vendorservices.epic.com/Resources/OEC09 , https://vendorservices.epic.com/Resources/OEC12
- https://www.healthcareitnews.com/news/epic-unveils-ai-agents-showcases-new-foundational-models , https://www.fiercehealthcare.com/ai-and-machine-learning/epic-touts-new-ai-applications-streamline-charting-and-bring-research , https://hlth.com/insights/news/epic-releases-native-ai-charting-for-integrated-clinical-documentation-2026-02-06
- https://hlth.com/insights/news/oracle-health-clinical-ai-agent-adds-automated-order-creation-features-2026-02-03 , https://www.techtarget.com/searchhealthit/news/366629120/Oracle-Health-releases-AI-powered-ambulatory-EHR , https://hitconsultant.net/2026/09/14/oracle-health-launches-clinical-ai-agent-for-nurses-inpatient-ehr-documentation/
- https://home.meditech.com/en/d/mktcontent/otherfiles/ambulatorybookletsinglepage.pdf , https://ehr.meditech.com/news/care4-project-delivers-single-patient-portal-across-acute-ambulatory-settings-with-meditech
- https://www.athenahealth.com/knowledge-hub/healthcare-technology/athenaone-athena-clinicals-collector-communicator , https://www.techradar.com/reviews/athenacollector
- https://www.eclinicalworks.com/eclinicalworks-and-sunoh-ai-revolutionize-patient-care-and-provider-efficiency-at-large-fqhc/
- https://www.businesswire.com/news/home/20240624829609/en/NextGen-Healthcare-Expands-Capabilities-of-NextGen-Ambient-Assist-and-Introduces-Tailored-Solution-for-Small-Practices-NextGen-Office-Ambient-Assist , https://www.nextgen.com/1-bh
- https://england.nhs.uk/long-read/electronic-prescription-service-eps , https://tandemhealth.ai/resources/knowledge/top-ehr-epr-systems-uk-primary-care
- https://www.capminds.com/blog/the-complete-guide-to-openemrs-features-and-benefits (third-party)
- https://openmrs.atlassian.net/wiki/spaces/Archives/pages/25501473 (Reference Application 2.4, archived)
- https://bahmni.atlassian.net/wiki/spaces/BAH/pages/39813212/Bahmni+Connect+Features
- https://docs.gnuhealth.org/his/features.html , https://pypi.org/project/gnuhealth-socioeconomics
- https://docs.frappe.io/erpnext/frappe-healthcare , https://github.com/frappe/healthcare
- https://github.com/HospitalRun/hospitalrun , https://medevel.com/hospitalrun-2021/
- https://www.medplum.com/products , https://www.medplum.com/blog/january-2026-update , https://www.medplum.com/blog/february-2026-update
- https://developers.dhis2.org/docs/mobile/android-capture-app/overview , https://docs.dhis2.org/en/implement/android-implementation/android-capture-overview.html
- https://developer.openehr.org/tooling/ , https://medblocks.com/blog/understanding-openehr-clinical-knowledge-manager
- Standards (gk, canonical public specs): https://hl7.org/fhir/R4/ , https://hl7.org/fhir/us/core/ , https://hl7.org/fhir/uv/bulkdata/ , https://smarthealthit.org/ , https://cds-hooks.org/ , https://www.ihe.net/resources/profiles/ , https://hl7.org/fhir/uv/ips/ , https://smart.who.int/

---

## 1. Registration, patient identity, MPI

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Patient demographic registration | Name, DOB, sex/gender, address, contacts, language, next of kin, photo | all | P0 |
| Multiple identifiers per patient | National ID, MRN, insurance IDs, phone, programme IDs, with identifier-type registry | EP OR MT EM TP OM BA GH MP D2 OE | P0 |
| Configurable registration fields | Admin-defined person attributes (caste, occupation, tribe, etc.) | OM BA GH OE D2 MH | P0 |
| Patient search (name fuzzy, phone, ID, DOB) | Fast typo-tolerant search incl. phonetic and local-script names | all; OM BA strong | P0 |
| Duplicate detection at registration | Warn on probable match before creating record | EP OR OM BA D2 (works offline) OE | P0 |
| Duplicate merge / unmerge | Merge two charts with audit and ability to undo | EP OR MT OM OE | P1 |
| Enterprise MPI / cross-facility matching | Probabilistic/deterministic linkage across sites | EP OR MT OM(via modules) | P1 |
| NHS number / national-ID verification | Trace against national spine/registry (PDS in UK; ABHA, national IDs elsewhere) | EM TP | P2 (country adapters) |
| Family / household linking | Relationships, household, domiciliary unit, family folder | GH BA(relationships) OM D2 | P1 |
| Unknown / emergency registration | Temporary identity then reconcile | EP OR MT OM BA | P1 |
| Photo / biometric capture | Photo, fingerprint for ID in low-resource settings | OM(modules) BA | P2 |
| Insurance / payer registration | Coverage, member ID, eligibility check at front desk | EP OR AT EC NG MT OE | P1 |
| Pre-registration / online registration | Patient fills demographics, forms, consents before visit | EP AT EC MT NG | P1 |
| Kiosk / contactless check-in | Self check-in, copay collection | EP AT EC(healow Check-in, Kiosk) MT | P2 |
| Registration quality rules | Required fields, validators (phone, ID checksum), age-based rules | all | P0 |
| Patient merge across programmes | One person, many programme enrolments | OM BA D2 GH | P1 |
| Patient flags / alerts banner | Allergies, infectious risk, safeguarding, VIP, interpreter needed | EP OR EM TP OE | P0 |
| Safeguarding / confidential record flag | Restricted visibility on sensitive patients | EP OR EM TP | P1 |
| Deceased / transfer-out handling | Mark deceased, deducted, transferred; stop recalls | EM TP EP OM | P1 |

Sources: Epic/Oracle/athena/eCW pages above; OpenMRS RefApp feature page (registration, patient search, patient summary); Bahmni docs; GNU Health features (demographics, domiciliary units); DHIS2 Android overview (offline duplicate check).

---

## 2. Scheduling, waitlists, referrals

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Provider / resource calendars | Per-clinician, room, equipment schedules with templates and exceptions | all | P0 |
| Appointment types and durations | Visit-type driven slot length, rules per type | all | P0 |
| Walk-in / same-day queue | Queue with triage priority and token numbers | OM BA EM TP | P0 |
| Appointment reminders | SMS/email/voice reminders with confirm/cancel | EP AT(athenaCommunicator) EC MT EM(via Accurx etc.) | P0 |
| Online self-scheduling | Patients book from portal/app against open slots | EP MT AT EC NG; MP exposes `$find`/`$book` | P1 |
| Recurring appointments / series | Repeating visits (physio, dialysis, ANC) | EP OR OM GH | P1 |
| Overbooking / double-book rules | Controlled overbook, no-show prediction | EP AT | P2 |
| No-show tracking and recall | Missed-visit list, auto outreach, defaulter tracing | EP AT D2 OM BA | P0 |
| Waitlist / cancellation fill | Waiting list auto-offers freed slots | EP AT MT | P1 |
| Group appointments | One slot, many patients (group education, antenatal class) | EP OR D2 | P2 |
| Multi-resource booking | Clinician + room + device in one booking | EP OR | P2 |
| Referral out (e-referral) | Structured referral with attachments, status tracking | EP OR EM TP AT NG | P0 |
| Referral in / triage | Referral worklist, accept/reject/redirect, priority | EP OR TP EM | P1 |
| Referral loop closure | Track that consult report came back | EP OR AT | P1 |
| Appointment-based recalls (chronic care) | Recall lists driven by registers (diabetes review due) | EM TP EP D2 | P0 |
| Cross-site scheduling | Book at another clinic in same org | EP OR MT | P1 |
| Telehealth appointment type | Video link attached to booking | EP OR AT EC NG MT | P1 |
| Home-visit scheduling / route | Visit list per community worker, map | TP GH D2(tracker) | P1 |
| Prior auth at scheduling | Eligibility and auth check before visit | AT EP OR | P2 |
| FHIR Slot/Schedule/Appointment API | Exposed scheduling resources | EP(open.epic scheduling) MP | P0 |

Sources: https://open.epic.com/Scheduling/FHIR ; Medplum Jan/Feb 2026 updates (`$find`, `$book`, custom fields before booking); MEDITECH ambulatory booklet (self-scheduling); athena blog; GNU Health features (appointments).

---

## 3. Clinical documentation

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Encounter / visit record | Visit container with type, location, practitioner, times, status | all | P0 |
| Chief complaint / HPI / ROS / exam / assessment-plan (SOAP) | Structured plus free-text note sections | all | P0 |
| Note templates / smart phrases | Reusable text with dynamic fields and macros | EP(SmartPhrases) OR AT EC NG OE; BA(form builder) | P0 |
| Structured data capture forms | Admin-built forms mapped to observations | OM(form engine) BA(Form Builder) OH(templates) GH D2 | P0 |
| Vitals and measurements | BP, pulse, temp, weight, height, BMI, SpO2, growth with units | all | P0 |
| Growth charts / percentile | Paediatric growth, head circumference, z-scores (WHO) | EP OR EM TP OM | P1 |
| Problem list | Active/resolved conditions with onset, coding | all | P0 |
| Diagnosis coding | ICD-10/ICD-11, SNOMED CT, local lists, concept search | all; OM concept dictionary | P0 |
| Allergy / intolerance list | Substance, reaction, severity with coded values | all | P0 |
| Medication history / current meds list | Reconciled med list | all | P0 |
| Immunization record | Vaccines with lot, site, schedule, forecast | EP OR EM TP GH D2 OM | P0 |
| Family and social history | Structured family hx, tobacco, alcohol, occupation | all; GH socioeconomics | P1 |
| Socioeconomic / SDOH capture | Housing, income, education, sanitation, food insecurity | GH EP OR D2 | P1 |
| Procedures / minor surgery notes | Coded procedure record with consent | EP OR EM OE GH | P1 |
| Clinical images / photo attach | Wound or derm photos on chart | EP OR OE BA | P1 |
| Document / scan attachment | Upload PDFs/images to chart with category | all (BA limited offline) | P0 |
| Document scanning / OCR indexing | Incoming letters classified and indexed | EP EM TP | P2 |
| Free-text and dictation | Voice-to-text for notes | EP OR NG AT | P1 |
| Problem-oriented summary / patient summary | One-screen overview with key data | OM(patient summary) EP OR EM TP | P0 |
| Longitudinal flowsheets / trends | Time series of vitals/labs with graphing | EP OR OM OE | P1 |
| Visit addenda / amend / late entry | Amend signed notes with audit trail | EP OR OE | P0 |
| Note signing and cosign | Sign, pend, cosign by supervisor or trainee | EP OR AT | P0 |
| Care plans / goals | Patient goals, interventions, owners | EP OR EM TP GH | P1 |
| Chronic disease templates / protocols | Diabetes, hypertension, asthma, TB, HIV structured reviews | EM TP BA OM D2 | P0 |
| Antenatal / maternal and child health | ANC, delivery, PNC, EPI cards | GH(obstetrics) OM D2 OR | P1 |
| Mental-health scales | PHQ-9, GAD-7 and scoring | EP NG(behavioral health) OE | P1 |
| Specialty templates | Cardiology, ophthalmology, derm, physio | EP AT NG EC | P2 |
| Clinical coding productivity (E/M) | Level suggestion, charge capture | EP OR AT EC | P2 (market dependent) |
| Dental / oral health charting | Odontogram | NG(oral health) GH(dentistry) | P2 |
| Chart review / summarisation | Cross-record summary for pre-visit | EP(Insights) OR | P2 |
| Clinical data model flexibility | Archetype/template-style versionable data definitions | OH OM(concepts) | P1 |
| Terminology service | Code system and value set browse, map, subset | EP OR OM OH MP | P0 |

Sources: OpenMRS RefApp 2.4 features (visits, vitals, allergies, visit notes); Bahmni docs; GNU Health features; athena blog (charting); Marley docs (encounters capture symptoms, diagnosis, notes, prescriptions, follow-up); openEHR tooling pages; eCW/NextGen pages.

---

## 4. Orders and results

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Lab order entry | Pick tests/panels, specimen, priority, clinical info | all | P0 |
| Order sets / favourites | Pre-built bundles by condition or user | EP OR MT AT EC NG | P1 |
| Imaging order entry | Modality, body part, indication, appropriateness | EP OR AT OE | P1 |
| Procedure / referral orders | Orders for non-lab tasks | EP OR EM TP | P1 |
| Order status tracking | Ordered, collected, resulted, reviewed | all | P0 |
| Result review and acknowledge | Per-result sign-off with comments | all | P0 |
| Abnormal flagging and critical values | Reference ranges, H/L/critical alerts and escalation | all | P0 |
| Result trending / cumulative view | Table or graph across time | EP OR OM OE | P1 |
| Result release to patient | Immediate or delayed release rules | EP(MyChart) AT MT | P1 |
| Pending-results worklist | Unreviewed/overdue results | EP OR AT EM TP | P0 |
| Point-of-care test capture | Glucose, HbA1c, malaria RDT, urine dip, pregnancy | OM BA EM TP EP | P0 |
| Standing / recurring orders | Repeat labs, monitoring schedules | EP OR EM TP | P1 |
| Order communication | Print, e-send via interface, fax | all | P0 |
| Orders via AI draft | Ambient agent proposes orders for approval | OR(Feb 2026) NG | P2 |
| Reflex / add-on orders | Add tests to existing specimen | EP OR (LIS) | P2 |
| Orders -> billing charge | Charge triggered on completion | AT EP OR MH GH BA(ERP) | P1 |
| Barcode / label printing | Specimen and patient labels | EP OR MT BA(OpenELIS) GH | P1 |
| External-lab interfaces (HL7 v2 ORM/ORU) | Send/receive with reference labs | all major; BA(HL7/Atomfeed to LIMS) | P0 |

---

## 5. E-prescribing and medication management

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Medication order / prescription writing | Drug, dose, route, frequency, duration, instructions | all | P0 |
| Drug dictionary (national formulary) | Coded drug database; local formulary override | EP OR EM TP(dm+d in UK) OM BA GH | P0 |
| Dose-form and unit handling | Strength, form, unit conversion, weight-based dosing | EP OR OM BA | P0 |
| Drug-allergy and drug-drug interaction checks | Alerts with severity, override reason | all commercial; OM(limited) BA(modules) GH | P0 |
| Duplicate therapy / dose-range checks | Max dose, renal/hepatic adjust, paeds dosing | EP OR EM TP | P1 |
| Repeat / chronic prescriptions | Repeat template with authorisation cycles and review dates | EM TP EP OR | P0 |
| Electronic transmission to pharmacy | Country-specific: EPS (England), NCPDP SCRIPT (US), national schemes | EM TP EP OR AT EC NG OE(Weno etc.) | P1 (adapter per country) |
| Prescription printing | PDF/paper, QR, signature | all | P0 |
| Controlled-substance rules | EPCS, registers, two-factor signing | EP OR AT EC NG | P2 (jurisdictional) |
| Medication reconciliation | Compare lists at transitions | EP OR MT | P1 |
| Medication review prompts | Structured annual / polypharmacy reviews | EM TP | P1 |
| Patient medication list in portal | View, refill request | EP AT MT EM TP | P1 |
| Refill request workflow | Patient asks, staff/clinician approves | EP AT EM TP | P1 |
| Formulary / insurance coverage check | Real-time benefit | EP OR AT | P2 |
| Dispensing record | What was dispensed, batch, qty (pharmacy module) | OM BA GH MH OE | P1 |
| Medication administration record (outpatient injection/vaccine) | Give-and-document | EP OR EM TP | P1 |
| Prescription audit / analytics | Antibiotic stewardship, high-risk prescribing | EM TP EP | P2 |
| Drug pricing / dm+d / RxNorm mapping | Terminology bind | OR EP EM TP | P1 |

Sources: https://england.nhs.uk/long-read/electronic-prescription-service-eps (EPS Phase 4 enabled on EMIS, SystmOne etc. since Feb 2023); OpenEMR third-party guides (Weno / NewCrop integrations); athena blog.

---

## 6. Clinical decision support (CDS)

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Allergy / interaction alerts | See section 5 | all | P0 |
| Health maintenance / preventive care reminders | Due screenings and vaccines by age/sex/risk | EP OR AT EC EM TP OE D2 | P0 |
| Rules engine (event-condition-action) | Admin-authored alerts/reminders | OM(modules) OE EP OR D2(program rules) MP(bots) | P1 |
| Clinical protocol / pathway guidance | Stepwise guidance (IMCI, HIV, TB, ANC) | D2 BA OM (WHO SMART digital adaptation) | P1 |
| Risk scores | QRISK, ASCVD, CHA2DS2-VASc, MEWS, etc. | EP OR EM TP | P1 |
| CDS Hooks (service calls at workflow moments) | External decision services return cards | EP OR(gk) MP | P1 |
| FHIR PlanDefinition/Library/CQL evaluation | Standards-based computable guidelines | MP(gk) OH(GDL) | P2 |
| Order appropriateness | Imaging criteria, lab stewardship | EP OR | P2 |
| Sepsis / deterioration predictions | Predictive models | EP OR | P2 (inpatient) |
| Alert fatigue controls | Severity tiers, override tracking, suppression | EP OR EM TP | P1 |
| Best-practice advisories in context | Inline nudge at ordering/charting | EP OR AT | P1 |
| Quality-measure gap alerts | "Patient due for X" tied to measures | EP AT EC EM TP | P1 |
| Pre-visit planning | Auto-prepare chart gaps before visit | EP AT EC | P2 |
| Chart summarisation by AI | Insights style | EP OR | P2 |

Sources: Epic developer pages via search (CDS Hooks described as Epic calling external service and rendering cards); DHIS2 docs (program rules, offline); cds-hooks.org (gk).

---

## 7. Inbox, tasks, messaging

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Clinician inbox (results, messages, refills, referrals, docs) | Unified work queue per user | EP(In Basket) OR AT EM TP EC NG | P0 |
| Task assignment | Task to user/role/pool with due date and priority | all | P0 |
| Delegation / cover / out-of-office | Reassign inbox to colleague | EP OR EM TP | P1 |
| Secure staff messaging | Internal chat linked to patient | EP OR EM TP AT | P1 |
| Patient-to-clinic messaging | Portal messages with triage routing | EP AT EC MT NG | P1 |
| Message routing rules | Auto-route by type to pool (admin, nurse, GP) | EP OR EM TP | P1 |
| Document workflow (incoming letters) | Review, code, action, file | EM TP EP | P1 |
| Results routing and escalations | Ensure unreviewed results escalate | EP OR | P1 |
| Reminders / ticklers | Time-based chart reminders | EP OR EM TP OE | P0 |
| Task templates / care bundles | Auto-spawn tasks from care plan | EP MP(bots) | P2 |
| AI inbox reply drafting | Draft reply to patient message for clinician edit | EP(ART: ~150 orgs, ~1M drafts/month per Epic Aug 2025) | P2 |
| AI patient-facing assistant | Explains results, schedules | EP(Emmie in MyChart, announced) | P2 |
| Triage / e-consult | Online consultation intake routed to staff | EM TP (via Accurx/online-consult add-ons) | P1 |
| FHIR Task / Communication / Flag | Standards backing | MP EP | P0 |

---

## 8. Care coordination, community, home visits

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Care team record | Named members, roles, contacts | EP OR EM TP GH | P1 |
| Shared record across organisations | Community, mental health, GP see one chart | TP(distinctive) EM(Care Record sharing) EP(Care Everywhere) | P2 |
| Programme / cohort enrolment | Enrol person into TB, HIV, ANC, NCD programme with stages | OM(programs) BA D2(tracker programs) GH | P0 |
| Longitudinal programme stages and events | Repeatable stages with scheduled due dates | D2 BA OM | P0 |
| Community health worker mobile client | Phone/tablet app, assigned households and patients | D2 BA(Connect) OM(mobile) GH | P0 |
| Household / domiciliary unit survey | Housing, water, sanitation, family functioning | GH D2 | P1 |
| Home visit record | Visit location, GPS, tasks, outcomes | GH TP D2 | P1 |
| Case-finding and tracing | Lists of defaulters, contacts to trace | D2 OM BA | P0 |
| Contact tracing | Index case to contacts, follow-up | D2 OM | P1 |
| Referral and counter-referral CHW to facility | Structured with feedback | D2 OM BA | P1 |
| Social prescribing / community resources | Referral to non-clinical services | EP OR EM(via add-ons) | P2 |
| Case management / complex care registers | Risk-stratified lists, outreach | EP AT EC | P1 |
| Remote patient monitoring | Home BP/glucose device data ingested | EP OR EC(healow RPM) AT | P2 |
| Transitions of care summary | Discharge/transfer summaries sent | EP OR EM TP | P1 |
| School / outreach / mass event mode | Bulk vaccination or screening entry | D2 | P1 |
| Geographic org-unit hierarchy | Region > district > facility > village | D2 OM(locations) BA | P0 |
| Scoped data access by org unit | CHW sees only own catchment | D2 | P0 |

Sources: DHIS2 Android overview (CHW use, sync limits, org-unit scoping); Bahmni Connect docs; GNU Health features (domiciliary units, socioeconomics); SystmOne shared-record description from tandemhealth review.

---

## 9. Patient portal and telehealth

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Portal login / proxy access | Patient and caregiver/parent access | EP AT MT EC NG EM(NHS App) TP | P1 |
| View records, results, meds, allergies, immunizations | Patient-facing chart | all with portals; OE | P1 |
| Appointment booking / cancel | Self-service | EP MT AT EC | P1 |
| Secure messaging | See section 7 | all portals | P1 |
| Questionnaires / pre-visit forms | Fill history, consent, PROs before visit | EP AT EC MT | P1 |
| Bill pay | Online balance payment | EP AT EC MT | P2 |
| Medication refill request | See section 5 | all portals | P1 |
| Mobile app / health-record integration | Apple Health Records style pull | MT EP | P2 |
| Telehealth video visit | Embedded visit, waiting room, interpreter | EP OR AT EC NG MT | P1 |
| Async e-consultation | Text/photo intake, reply later | EM TP-add-ons | P1 |
| Portal for proxy of minors, privacy by age | Age-based sharing rules | EP OR | P2 |
| Patient record download / export | Bulk or PDF download, FHIR patient access API | EP (patient access), MP | P1 |
| SMS-only patient channel | Reminders and notices without app | AT EC EP D2(SMS) | P0 (for low-resource) |
| Patient-generated data | Self-reported vitals, symptom diary | EP EC | P2 |

Sources: MEDITECH booklet and CARE4 article (portal features); athena blog (athenaCommunicator); eCW release (healow check-in, kiosks).

---

## 10. Billing, revenue cycle, claims

Note: outpatient v0.x for non-US markets needs flexible billing (self-pay, schemes, insurance, fee schedules) more than US claims. US-style RCM is P2.

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Service/charge master (fee schedule) | Priced services with tax rules, multiple price lists | all | P0 |
| Charge capture from encounter | Visit/orders create charges | AT EP OR MH GH BA(ERP) OE | P0 |
| Invoice and receipt | Itemised, printable, with payment recording | all | P0 |
| Cash / self-pay, deposit, refund | Counter payments, advances, credit notes | MH GH BA OM(billing module) OE | P0 |
| Payment methods | Cash, card, mobile money, bank | MH BA | P0 |
| Exemptions / waivers / sliding scale | Free care categories, charity, discounts | BA MH GH AT | P0 |
| Insurance / payer plans | Coverage, copay, authorisation | EP OR AT EC NG MT OE | P1 |
| Eligibility verification | Real-time check | AT EP EC NG | P2 |
| Claim generation (X12 837, national formats) | Electronic claims to payer | AT EP OR EC NG OE(X12) | P2 |
| Remittance / ERA posting | Auto-post payments | AT EP OR | P2 |
| Denial management / worklists | Rework rejected claims | AT(add-on service) EP OR | P2 |
| Prior authorisation | Request and track | AT EP OR | P2 |
| Coding assist (CPT/ICD, E/M) | Suggested codes, AI-assisted professional fee codes | EP OR(Aug 2026 report) AT | P2 |
| Statements / collections | Patient statements, aging | AT EP OR | P2 |
| Financial reports | Revenue, collections, outstanding by clinic/payer | all | P1 |
| Accounting integration | GL/ERP export | BA(ERP) MH(ERPNext native) GH | P1 |
| Capitation / block-contract tracking | Population-based payment models | EM TP(NHS contract) | P2 |
| Cash drawer / shift reconciliation | End-of-day totals | MH BA | P1 |

Sources: athena blog + TechRadar (eligibility, copay at time of service, denial/prior-auth add-ons); Oracle coverage (fee code suggestions); Marley/Frappe docs (ERP-native billing, `gk` partially).

---

## 11. Inventory and pharmacy

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Item master (drugs, consumables, vaccines) | Coded items with units, strengths | BA MH GH HR OM(modules) | P0 |
| Stock on hand per location | Store, dispensary, ward stock | BA MH GH HR OR MT | P0 |
| Receipts / purchase orders | Goods received, supplier | BA MH GH HR | P1 |
| Batch and expiry tracking | Lot, expiry, FEFO issue, expiry alerts | BA MH GH OR MT | P0 |
| Stock adjustments and wastage | Reason-coded write-offs | BA MH HR | P0 |
| Reorder levels / low-stock alert | Thresholds | BA MH HR | P1 |
| Inter-store transfers | Central store to clinic | BA MH GH | P1 |
| Dispensing against prescription | Pharmacist worklist; partial fill | all pharmacy modules | P0 |
| Vaccine cold-chain stock | Vaccine stock with temp logs | D2(logistics) | P2 |
| Barcode scanning | GS1/QR for items | OR MT | P2 |
| Supply-chain reporting / consumption | Usage trends, forecasting | BA D2(aggregates) MH | P1 |
| Pharmacy compounding / IV admixture | Inpatient pharmacy | OR MT EP | P2 |
| Controlled drug register | Running balance and witness | EP OR GH | P1 |
| Outpatient pharmacy integration | e-Rx to community pharmacy | EM TP EP OR | P1 |

Sources: Bahmni video catalogue (stock, products, billing from ERP integration); GNU Health feature list; HospitalRun coverage (Inventory Manager role).

---

## 12. Laboratory (LIS)

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Test catalogue (panels, analytes, units, ranges) | Configurable by age/sex | BA(OpenELIS) GH(LIMS) MH OM EP(Beaker, gk) OR(PathNet, gk) | P0 |
| Specimen collection and labelling | Accession, barcode, containers | all LIS | P0 |
| Sample receipt / rejection | Condition checks | OpenELIS GH EP OR | P1 |
| Result entry (manual) | Per analyte with validation | all | P0 |
| Instrument interfaces | ASTM/HL7 analyzer interfaces | OpenELIS EP OR | P2 |
| Result validation / authorisation | Tech then pathologist sign-off | all LIS | P1 |
| Reference / critical ranges | By demographic | all | P0 |
| Microbiology (culture, sensitivity) | Organism/antibiogram | EP OR OpenELIS | P2 |
| Anatomic pathology | Histology workflow | EP OR MT | P2 |
| Blood bank | Compatibility, issue | EP OR MT | P2 |
| Quality control (Levey-Jennings) | QC runs | OpenELIS EP OR | P2 |
| Referral lab send-outs | Track samples to external lab | EP OR OpenELIS | P1 |
| Lab to EHR integration | Orders out, results in (HL7/FHIR) | BA(Atomfeed/HL7) GH EP OR | P0 |
| Lab billing | Charge per test | GH(services-lab) BA MH | P1 |
| Public-health lab reporting | Notifiable disease reporting | EP OR D2 | P1 |
| Lab worklists / TAT metrics | Turnaround, outstanding | all | P1 |

Sources: Bahmni video catalogue (OpenELIS as Bahmni lab; HL7/Atomfeed LIMS integration); https://www.gnuhealth.org/lims ; https://pypi.org/project/gnuhealth-services-lab/ .

---

## 13. Imaging

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Imaging order and result report | Text report attached to chart | all | P0 |
| Radiology worklist (RIS) | Scheduling, protocols, reporting queue | EP(Radiant, gk) OR MT GH(imaging) BA(Bahmni PACS integration) | P2 |
| PACS link / viewer launch | Open study from chart (DICOMweb/context launch) | EP OR MT BA | P1 |
| DICOM storage (internal) | Store images | BA(Orthanc-based, gk) GH(Orthanc) | P2 |
| Structured reporting / templates | Report templates | EP OR | P2 |
| Ultrasound point-of-care capture | Clinic ultrasounds (ANC) with images | OM(modules) GH | P2 |
| Teleradiology | External reader routing | EP OR | P2 |
| Imaging appropriateness | Decision support | EP OR | P2 |
| FHIR ImagingStudy / DiagnosticReport | Standards exposure | MP EP | P1 |

---

## 14. Inpatient: ADT, bed management, MAR (later phase)

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Admission / discharge / transfer | Movements with reasons, locations | EP OR MT OM(ADT) BA GH MH HR | P2 |
| Bed / ward board | Occupancy, cleaning status, assignment | EP OR MT BA GH MH | P2 |
| Bed request / placement | Flow between ED, wards, ICU | EP OR MT | P2 |
| Emergency department tracking board | Triage, status, location | EP OR MT | P2 |
| Inpatient orders / order sets | Admission orders, protocols | EP OR MT | P2 |
| MAR with barcode administration | Five rights checks | EP OR MT | P2 |
| Nursing assessments / care plan | See section 15 | EP OR MT | P2 |
| Discharge summary and planning | Generated summary, meds, follow-up | EP OR MT BA GH | P2 |
| Theatre / surgical scheduling | Cases, preference cards | EP OR MT | P2 |
| Diet / meal orders, housekeeping | Support services | EP OR MT | P2 |
| Inpatient billing (packages, DRG) | Package charges | BA MH GH EP | P2 |
| Obstetrics / labour ward partograph | Labour monitoring | GH OM(modules) | P2 |
| Observation-only / short-stay in clinics | Day-case beds | OM BA | P2 |

Sources: OpenMRS RefApp 2.4 features (admissions/discharges/transfers); Bahmni video catalogue (IPD workflow); Marley docs (inpatient management); Oracle press (inpatient nursing agent).

---

## 15. Nursing

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Triage (e.g. emergency severity, WHO triage) | Acuity scoring | OM BA EP OR | P0 |
| Nurse vitals/intake workflow | Rooming, pre-visit data | all | P0 |
| Nursing notes and flowsheets | Intake/output, pain, falls risk | EP OR MT MH | P2 for inpatient; P1 for clinic basics |
| Nurse-led clinics / protocol-based orders | Standing orders executed by nurse | EP OR EM TP | P1 |
| Wound care / procedure documentation | Photos, dressings | EP OR | P1 |
| Voice-to-structured nursing charting | Spoken observations to fields | OR(Sept 2026 report) | P2 |
| Task lists per nurse | Due procedures/meds | EP OR MT | P1 |
| Handover / shift report | Shift notes | EP OR MT | P2 |

---

## 16. Reporting, analytics, population health

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Operational reports (visits, no-shows, wait times) | Standard dashboards | all | P0 |
| Ad-hoc / report builder | User-built filters and exports | OM(reporting module) OE BA D2 MH GH | P1 |
| Disease registers (diabetes, HTN, etc.) | Auto-populated cohorts with care-gap flags | EM TP EP AT EC D2 | P0 |
| Quality indicators / measures | QOF-like, MIPS-like, HEDIS-like, WHO indicators | EM TP EP AT EC NG | P1 |
| Aggregate reporting to ministry | Monthly facility returns via DHIS2/HMIS | D2 OM BA(DHIS connector) | P0 |
| Indicator engine | Numerator/denominator definitions, disaggregation | D2 | P1 |
| Geospatial maps | Cases per area | D2 GH | P2 |
| Population risk stratification | Predictive scoring for outreach | EP OR AT EC | P2 |
| Data warehouse / export | Replica DB, flat exports, OMOP/FHIR bulk | EP(Clarity-like, gk) OR OM BA MP | P1 |
| Research cohort / de-identification | Cohort discovery, de-id export | EP OR | P2 |
| Public-health reporting (immunisation registry, syndromic, notifiable) | Standard feeds | EP OR AT EC | P1 |
| Practice dashboard / KPIs | Real-time operational | EP AT EC MT | P1 |
| Audit/usage analytics | Who accessed what | EP OR | P1 |
| Payer data exchange | Quality and risk data to plans | EC(healow Insights, per release) EP | P2 |

Sources: DHIS2 docs; OpenMRS RefApp page; eCW release (population health, RPM, Insights); GNU Health (analytics area).

---

## 17. Interoperability

| Feature | One-line | Who | Pri |
|---|---|---|---|
| FHIR R4 REST API (read/search/write) | CRUD+search on core resources | EP(DSTU2/STU3/R4) OR MP BA(FHIR module) OM(FHIR2 module) OE GH(gk) MH(FHIR-inspired) | P0 |
| US Core / national IG profiles | Profile conformance and validation | EP OR MP OE | P1 |
| SMART on FHIR app launch (EHR + standalone) | OAuth2/OIDC app framework, scopes | EP OR MP OE(gk) | P0 |
| SMART backend services | Signed-JWT system-to-system auth | EP OR MP | P1 |
| Bulk Data (`$export`) | Ndjson population export | EP OR MP OE(gk) | P1 |
| Subscriptions | Event notifications via webhook/websocket | MP EP(gk) | P1 |
| FHIR operations: `$everything`, `$validate`, `$document`, `$lastn` | Common operations | MP EP | P1 |
| FHIR Messaging / Documents | Bundle exchange, document refs | MP | P2 |
| International Patient Summary (IPS) | Portable minimal summary | MP(gk) OH | P1 |
| HL7 v2 (ADT, ORM, ORU, SIU, MDM, VXU, DFT) | Legacy interfaces, MLLP | EP OR MT AT EC NG OE BA(HL7 to lab) | P0 |
| HL7 v3 / C-CDA documents | CCD exchange, patient transitions | EP OR MT AT EC NG OE | P1 |
| IHE profiles (XDS.b, PIX/PDQ, ATNA, XCA, MHD, PDQm, PIXm) | Cross-enterprise document sharing, ID cross-ref | EP OR MT OM(gk) OpenHIE ecosystem | P1 |
| OpenHIE architecture (client registry, facility registry, SHR) | Country-level HIE pattern | OM BA D2 | P2 |
| DICOM / DICOMweb | Imaging | EP OR MT | P1 |
| NCPDP SCRIPT, X12 270/271/837/835 | US pharmacy and payers | EP OR AT EC NG OE | P2 |
| Direct secure messaging | US Direct | EP OR AT EC NG OE | P2 |
| National platforms (NHS Spine/EPS/GP Connect, ABDM, etc.) | Country adapters | EM TP | P2 per country |
| Terminology: SNOMED CT, LOINC, ICD-10/11, RxNorm/dm+d, CVX | Code systems and mappings | all | P0 |
| Concept dictionary with mappings | Local concepts mapped to standard codes | OM BA OH(archetypes bind) | P0 |
| openEHR archetype/template + AQL | Two-level modelling; repository REST + query | OH | P2 (design inspiration) |
| Open API marketplace / app store | Vendor ecosystem | EP(open.epic, Showroom) OR AT(Marketplace) MP | P2 |
| Webhooks / bots / scripting | Customer automations | MP(bots) EP OR | P1 |
| Interface engine (queueing, retries, dead letter) | Reliable messaging layer | EP OR; MP | P0 |
| Atom/event feed integration | Event push between modules | BA | P2 |

Sources: https://open.epic.com/Home/Interoperate (HL7 v2/v3, NCPDP, CDA, ANSI, DICOM, FHIR DSTU2/STU3/R4); Epic Vendor Services decks (500+ FHIR APIs, 150+ public APIs per Epic); https://www.medplum.com/products (bots, subscriptions); third-party Epic guides (SMART flows, `$export`, CDS Hooks); Bahmni video catalogue; openEHR tooling pages.

---

## 18. Security, audit, consent, break-glass

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Role-based access control | Roles, privileges, per-location scope | all | P0 |
| Attribute / compartment-based access | Rules by org unit, patient relationship | MP D2 EP OR | P0 |
| Authentication (password policy, MFA, SSO/OIDC/SAML) | Secure sign-in | all | P0 |
| Session timeout / auto-lock / proximity badge | Idle lock; fast user switching | EP OR MT | P1 |
| Audit trail (who viewed/changed what, when) | Immutable access and change log | all | P0 |
| Patient-accessible access report | "Who looked at my chart" | EP OR | P2 |
| Break-the-glass | Emergency override with reason and alert | EP OR MT EM TP | P0 |
| Restricted / confidential records | Sensitive flags, sealed notes | EP OR EM TP | P1 |
| Consent capture and enforcement | Treatment, data sharing, research, programme-specific | EP OR EM(sharing consent) TP(sharing choices) MP(Consent resource) | P0 |
| Data subject rights tooling (GDPR / local) | Access, rectification, erasure rules vs medical-record retention | EM TP EP(gk) | P1 |
| Encryption in transit and at rest | TLS, disk/column encryption | all | P0 |
| Digital signature of notes | Signed clinical documents | EP OR | P1 |
| Pseudonymisation / de-identification | For analytics | EP OR D2 | P1 |
| Privacy-monitoring analytics | Anomalous access detection | EP OR (gk) | P2 |
| Data residency / multi-tenant isolation | Tenant separation | MP EP | P1 |
| Backups and restore tests | Encrypted, scheduled | all | P0 |
| Medico-legal retention rules | Retention schedules per country | EM TP EP | P1 |
| Certification alignment (ONC HTI, NHS DCB, etc.) | Regulated conformance | EP OR AT EC NG OE (claimed, conflicting sources) | P2 |

Sources: MP product page (access policies); Mindbowser Medplum guide (SMART scopes, compartments); Marley/GNU Health third-party notes on role-based access and audit.

---

## 19. Administration and configuration

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Facility / location hierarchy | Org > site > clinic > room | all | P0 |
| User and role management | Create users, assign roles/locations | all | P0 |
| Metadata management (concepts, forms, programs, drugs, services) | Admin UI plus import/export | OM BA D2 MH GH | P0 |
| Form builder / template designer | No-code clinical forms | BA(Form Builder) OM(form engine) D2 OH(templates) EP(gk) | P0 |
| Configuration as code / versioned metadata | Export, review, deploy config between envs | D2 OM MP OH | P1 |
| Terminology management UI | Maintain concept lists and mappings | OM OH | P1 |
| Localisation and multi-language UI | Translatable labels, RTL, scripts | OM D2 GH BA | P0 |
| Multi-tenant / multi-site | One install, many orgs | MP D2 EP OR | P1 |
| System health, jobs, logs | Admin diagnostics | OM D2 MP | P1 |
| Printable outputs / templates | Letters, prescriptions, certificates, labels | all | P0 |
| Sandbox / test environment, seed data | Training | EP OR MP OM(demo data) | P1 |
| Upgrade / migration tooling | Safe schema migration, rollback | all | P0 |
| Data import / migration tools | Bulk load patients, legacy data | OM BA OE | P1 |
| Feature flags / module toggles | Enable per site | GH(modular) OM(modules) MP | P1 |
| Plug-in / module architecture | Third-party extension points | OM(OSGi-style modules, gk) GH(Tryton modules) MP(bots) | P1 |
| Open API docs / developer portal | Self-service dev docs | EP MP OM | P1 |

---

## 20. Downtime and offline

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Read-only downtime view (business continuity) | Local read-only copy of schedule/chart/meds when server down | EP(BCA, gk) OR MT | P1 |
| Printed downtime forms and reconciliation | Paper fallback and back-entry | EP OR MT | P1 |
| Offline-first client (full CRUD) | Local DB, queued sync, conflict handling | D2(Android) BA(Connect, registration and clinical only) HR(PouchDB/CouchDB) OM(offline mode modules, gk) | P0 for community mobile; P1 for clinic web |
| Selective sync by assignment | Only sync assigned org units/patients, cap on records | D2(default up to 500 enrolments, configurable) BA | P0 |
| Conflict resolution rules | Last-write-wins vs field-level merge vs manual | D2 HR OH(gk) | P0 |
| Local-first LAN server | Clinic runs a local node that syncs upstream | OM BA(gk) GH | P1 |
| Resilient interfaces | Queue outbound messages during outage | EP OR | P0 |
| Emergency access package | Cached summary for key patients | EP | P2 |
| Offline limits clearly shown | UI tells users what cannot be done offline | BA D2 | P0 |

Known gaps (documented): Bahmni Connect offline lacks document attach, queues, programme observations; DHIS2 community threads report offline-login and sync-error issues, so design test cases here.

---

## 21. Mobile

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Responsive clinician web app | Works on tablets/phones | all modern | P0 |
| Native/PWA clinician mobile app | Rounding, chart review, e-sign | EP(Haiku/Rover, gk) OR NG(Mobile) AT | P1 |
| CHW Android app | Offline tracker capture | D2 BA(Connect) OM | P0 |
| Patient mobile app | Portal on phone, push notifications | EP(MyChart) AT MT EC(healow) | P1 |
| Phone camera capture | Wound photos, document scan, QR/barcode | EP OR D2 | P1 |
| GPS / location stamping | Visit geotag | D2 GH | P1 |
| Voice capture / ambient on phone | Phone as ambient scribe mic | OR NG EP | P2 |
| Biometric device unlock | Fingerprint/face to unlock app | D2(gk) EP | P1 |
| Push / SMS notifications to staff | Task and result alerts | EP OR | P1 |

Sources: NextGen Ambient Assist (runs through NextGen Mobile app); Oracle Clinical AI Agent (phone app recording); DHIS2 Android docs.

---

## 22. AI features

| Feature | One-line | Who | Pri |
|---|---|---|---|
| Ambient scribe (visit to draft note) | Records encounter, drafts note for clinician review/sign | EP(AI Charting GA reported Feb 2026) OR(Clinical AI Agent) NG(Ambient Assist; psychiatry, cardiology, peds, primary-care models; Spanish) EC(Sunoh.ai) AT(gk) | P2 |
| Order drafting from conversation | Proposes Rx/labs/imaging/referral/follow-up for approval | OR(Feb 2026) NG(decision support on dx and orders, per 2024 release) | P2 |
| Chart summarisation / pre-visit insights | Summarises history, labs, meds | EP(Insights) OR | P2 |
| Inbox / patient-message reply drafting | Clinician edits AI draft | EP(ART) | P2 |
| Patient-facing AI assistant | Explains results, schedules | EP(Emmie) | P2 |
| Coding suggestions | Fee code suggestions confirmed by clinician | OR(report Aug 2026) | P2 |
| Nursing voice charting | Spoken to structured fields | OR | P2 |
| Dictation + transcription | Speech to text in fields | OR NG EP | P1 |
| Predictive models (deterioration, no-show) | Risk models | EP OR | P2 |
| Human-in-loop and audit of AI content | Clinician must review/sign; log AI provenance | all vendors state this | P0 (if any AI added) |
| Local/self-hosted model option | No PHI to third party; works in low-bandwidth | none commercial known; design differentiator | P2 |
| Multilingual transcription | Local languages | NG(Spanish) | P2 |

Caveat: all time-saved and accuracy numbers are vendor-reported.

Sources: Healthcare IT News and Fierce on Epic; hlth.com Epic AI Charting item; hlth.com and TechTarget on Oracle; BusinessWire NextGen; eCW Sunoh.ai release.

---

## 23. Low-resource settings: what matters most

| Capability | Why it matters | Reference systems | Pri |
|---|---|---|---|
| Offline-first sync with selective download | Intermittent power/connectivity; CHWs in field | D2 Android, Bahmni Connect, HospitalRun (archived), OM | P0 |
| Low-bandwidth web: small payloads, delta sync, compression, pagination | 2G/3G, metered data | D2 | P0 |
| Runs on cheap hardware / single VM / Raspberry-class / low RAM | Clinic server may be old PC | OM BA HR GH | P0 |
| Local-first node with later upstream sync | Facility LAN works if WAN down | OM BA GH | P1 |
| SMS reminders and two-way SMS | Phones are universal, apps not | D2 EP AT | P0 |
| USSD / WhatsApp-style channels | Reach feature phones (adapter) | gk (not in sources) | P2 |
| Multilingual UI and local-script patient names | Language variety; transliteration search | OM D2 GH | P0 |
| Local calendars / date handling (Nepali, Ethiopian, Hijri etc.) | Birth dates, ANC dates | D2 (gk) | P2 |
| CHW workflows: household lists, due lists, referral/counter-referral, supervisor view | Community care model | D2 BA GH | P0 |
| Programme-centric care (TB, HIV, ANC, EPI, nutrition, NCD) | Vertical programmes dominate | D2 OM BA | P0 |
| WHO SMART guidelines / digital adaptation kits | Guideline-to-code alignment | smart.who.int (gk) D2 | P1 |
| National aggregate reporting (DHIS2 export) | Mandatory ministry returns | D2 OM BA | P0 |
| Free-care / exemption billing, donor-funded stock | Revenue model | BA MH | P0 |
| Light inventory with expiry and stockout alerts | Drug stockouts | BA MH HR | P0 |
| Paper-friendly outputs and downtime forms | Printing and carbon-copy habits | all | P1 |
| Simple deployment: Docker, backups to USB/cloud, auto-update | No on-site IT | MP BA OM | P0 |
| Power-loss safe storage | Journal/WAL, transactions | engineering | P0 |
| Biometric / photo ID for dedup | No national ID | OM(modules) | P2 |
| Voice-first / icon-based UI for low literacy staff | Training load | gk | P2 |
| Open licence, no per-seat cost | Budget | OM BA GH OE MP | P0 |
| Data sovereignty: self-host in-country | Regulation | OM BA GH MP | P0 |

Sources: https://developers.dhis2.org/docs/mobile/android-capture-app/overview ; https://bahmni.atlassian.net/wiki/spaces/BAH/pages/39813212/Bahmni+Connect+Features ; https://medevel.com/hospitalrun-2021/ ; https://docs.gnuhealth.org/his/features.html .

---

## 24. Cross-cutting design observations (for Arogya architecture)

1. FHIR-native store with a small clinical-data core (Patient, Practitioner, Organization, Location, Encounter, Condition, Observation, AllergyIntolerance, MedicationRequest/Dispense/Administration, ServiceRequest, DiagnosticReport, Immunization, Appointment/Slot/Schedule, Task, Communication, DocumentReference, Consent, Provenance, AuditEvent, CarePlan, EpisodeOfCare/PlanDefinition for programmes). Medplum and Marley's FHIR-inspired model show it is workable.
2. Metadata-driven forms (OpenMRS/Bahmni/openEHR/DHIS2 lesson): without admin-built forms a project cannot serve diverse clinics or programmes. Map form fields to coded Observations.
3. Programmes/episodes as first class (DHIS2/OpenMRS): enrolment, stages, scheduled events, due-lists.
4. Sync is the hardest feature. Decide early: per-resource versioning (FHIR `meta.versionId`), assignment-scoped download, deterministic conflict policy, tombstones.
5. Audit + consent + break-glass must be in the core, not added later (all mature EHRs treat these as infrastructure).
6. Terminology service: ship with a thin local concept dictionary plus mappings to SNOMED/LOINC/ICD/RxNorm; avoid licence traps (SNOMED affiliate licence per country; check before bundling).
7. Interop adapters per country (prescription transmission, national ID, claims) behind a plug-in boundary; keep core country-neutral.
8. Bots/subscriptions (Medplum pattern) give automation and integration without forking core.
9. AI features: optional, human-in-loop, provenance-tagged, pluggable provider (including local model). All reviewed vendors keep clinician sign-off mandatory.
10. Billing in v0.x: charge master, invoices, receipts, exemptions, payments, daily reconciliation. Defer claims/RCM.

---

## 25. Suggested v0.x P0 checklist (condensed)

1. Patient registration with identifiers, search, dup warning, alerts banner.
2. Locations/org hierarchy, users, roles, scoped access, MFA/OIDC.
3. Audit log, consent, break-glass, encryption, backups.
4. Scheduling (calendars, types, walk-in queue, reminders via SMS, no-show lists).
5. Encounter + notes (templates), vitals, problems, allergies, immunizations, meds list.
6. Form builder + coded concept dictionary + terminology service.
7. Lab/imaging orders, results review/acknowledge, abnormal flags, pending-results list.
8. Prescribing with formulary, allergy/interaction check, repeats, print; dispensing + stock with batch/expiry.
9. Tasks/inbox, referrals out with loop tracking, recalls and registers for chronic conditions.
10. Programme enrolment, due lists, CHW offline mobile client with selective sync.
11. Charge master, invoice/receipt, exemptions, payments, daily close.
12. Operational and aggregate reports with DHIS2-style export.
13. FHIR R4 API, SMART launch, HL7 v2 (ADT/ORU/ORM), interface queue.
14. Localisation and multilingual search.
15. Migration, import, upgrade tooling.
