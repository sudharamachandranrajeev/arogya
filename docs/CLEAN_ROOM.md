# Clean-room method

1. **Inputs allowed:** public standards (FHIR R4, LOINC, HL7 code systems), vendor marketing and public documentation read as *capability descriptions*, published research and government reports, public user feedback.
2. **Inputs not allowed:** proprietary or GPL source code, database schemas, screenshots or layouts, decompiled or disassembled binaries, confidential material, copied wording.
3. **Process:** research notes in `docs/research/` list *what* users need and *which products offer it*, in our own words, with source URLs. Code is written from those notes and from the FHIR specification, not from any product's implementation.
4. **Data model:** clinical data is stored as FHIR resources. This is a standard interchange format, not any vendor's internal schema.
5. **Drug knowledge:** `data/drugs.json` is a small illustrative table written from general pharmacology. It is not copied from a formulary and is not a complete clinical source.
6. **Contributors** must follow the same rules. Do not paste code or text from other EHRs into issues or pull requests.
