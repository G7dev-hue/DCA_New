# # from fastapi import FastAPI, HTTPException
# # from fastapi.middleware.cors import CORSMiddleware
# # from pydantic import BaseModel
# # import uvicorn

# # from compare_patients import trim_patient_data, ask_ollama

# # app = FastAPI(title="AI Insurance Matcher")

# # # Allow the HTML UI to talk to this API
# # app.add_middleware(
# #     CORSMiddleware,
# #     allow_origins=["*"],

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from new_plan import generate_new_plan_pdf
import uvicorn

from compare_patients import match_insurance_plan

from patient_notes import build_patient_notes

from fastapi.responses import Response, FileResponse
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from typing import List
from datetime import datetime
from starlette.concurrency import run_in_threadpool
import functools
import base64
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
from pdf_extractor import parse_insurance_pdf
from Appointment_Scheduler.appointment_processor import (
    process_appointments,
    generate_day_start_reports,
    build_office_reports,
    load_exclusions,
    save_exclusions,
    load_block_names,
    save_block_names,
    history_info,
    reset_history,
)
from Appointment_Scheduler.email_sender import (
    email_office_reports,
    load_email_map,
    parse_email_map_upload,
)

app = FastAPI(title="AI Insurance Matcher")

# Allow the HTML UI to talk to this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request models ────────────────────────────────────────────────────────────

class MatchRequest(BaseModel):
    portal_data: dict
    denticon_data: dict

class NotesRequest(BaseModel):
    denticon_data: dict
    insurance_data: dict

class PDFRequest(BaseModel):
    portal_data: dict
    denticon_data: dict

class InsOverride(BaseModel):
    insName:      Optional[str] = None
    feeSchedule:  Optional[str] = None
    relationship: Optional[str] = None

class NewPlanRequest(BaseModel):
    portal_data:   dict
    denticon_data: dict
    ins_override:  Optional[InsOverride] = None   # ← carries modal values

class ExclusionRequest(BaseModel):
    exclusions: list

class BlockNamesRequest(BaseModel):
    block_names: list


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def serve_ui():
    """Serve the web UI (index.html) so it can be opened directly from the server."""
    return FileResponse(os.path.join(BASE_DIR, "index.html"))


@app.post("/api/match")
async def match_patient_plan(req: MatchRequest):
    if not req.portal_data or not req.denticon_data:
        raise HTTPException(status_code=400, detail="Missing portal or denticon data")

    print("Matching portal data against Denticon plans...")
    result = await match_insurance_plan(req.portal_data, req.denticon_data)
    return result


@app.post("/api/patient-notes")
def generate_notes(req: NotesRequest):
    if not req.denticon_data or not req.insurance_data:
        raise HTTPException(status_code=400, detail="Missing denticon or insurance data")

    result = build_patient_notes(req.denticon_data, req.insurance_data)
    return result

@app.post("/api/generate-new-plan-pdf")
async def generate_new_plan_pdf_api(req: PDFRequest):

    if not req.portal_data or not req.denticon_data:
        raise HTTPException(
            status_code=400,
            detail="Missing portal or denticon data"
        )

    pdf_bytes = generate_new_plan_pdf(
        req.portal_data,
        req.denticon_data
    )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition":
            "attachment; filename=insurance_breakdown.pdf"
        }
    )

@app.post("/api/parse-pdf")
async def parse_pdf_endpoint(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Uploaded file must be a PDF")
    pdf_bytes = await file.read()
    
    try:
        result = await parse_insurance_pdf(pdf_bytes)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF parsing failed: {str(e)}")
    
@app.get("/api/health")
def health():
    return {"status": "ok"}


# ── Appointment cleansing (SOP Steps 2–5) ──────────────────────────────────────

@app.post("/api/appointments/process")
async def process_appointments_api(
    files: List[UploadFile] = File(...),
    commit: bool = Form(True),
):
    """
    Union one or more Denticon appointment reports, run the SOP cleansing steps
    (remove previously processed / invalid / duplicate / excluded-insurance),
    and return a per-step summary plus the cleaned workbook (base64).
    """
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one appointment report.")

    payload = []
    for f in files:
        name = f.filename or "report.xlsx"
        if not name.lower().endswith((".xlsx", ".xls", ".csv")):
            raise HTTPException(status_code=400, detail=f"'{name}' must be an .xlsx, .xls or .csv file.")
        payload.append((name, await f.read()))

    try:
        result = process_appointments(payload, commit=commit)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Processing failed: {e}")

    return {
        "summary": result["summary"],
        "filename": f"cleaned_appointments_{datetime.now():%Y%m%d}.xlsx",
        "file_base64": base64.b64encode(result["xlsx_bytes"]).decode("ascii"),
    }


@app.post("/api/appointments/day-start-reports")
async def day_start_reports_api(files: List[UploadFile] = File(...)):
    """
    SOP Step 6 — Generate an office-wise Day Start Report from the cleaned data
    and return them bundled as a ZIP (one Excel per office). Read-only: does not
    commit to history.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one appointment report.")

    payload = []
    for f in files:
        name = f.filename or "report.xlsx"
        if not name.lower().endswith((".xlsx", ".xls", ".csv")):
            raise HTTPException(status_code=400, detail=f"'{name}' must be an .xlsx, .xls or .csv file.")
        payload.append((name, await f.read()))

    try:
        result = generate_day_start_reports(payload)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    return {
        "summary": result["summary"],
        "filename": f"day_start_reports_{datetime.now():%Y%m%d}.zip",
        "file_base64": base64.b64encode(result["zip_bytes"]).decode("ascii"),
    }


@app.get("/api/appointments/exclusions")
def get_exclusions():
    return {"exclusions": load_exclusions()}


@app.post("/api/appointments/exclusions")
def update_exclusions(req: ExclusionRequest):
    return {"exclusions": save_exclusions(req.exclusions)}


@app.get("/api/appointments/block-names")
def get_block_names():
    return {"block_names": load_block_names()}


@app.post("/api/appointments/block-names")
def update_block_names(req: BlockNamesRequest):
    return {"block_names": save_block_names(req.block_names)}


@app.get("/api/appointments/history")
def get_history():
    return history_info()


@app.post("/api/appointments/history/reset")
def clear_history():
    return reset_history()


# ── Step 6 Part B: email office reports via Outlook ─────────────────────────────

@app.get("/api/appointments/email-map")
def get_email_map():
    return load_email_map()


@app.post("/api/appointments/email-map/upload")
async def upload_email_map(file: UploadFile = File(...)):
    name = file.filename or "mapping.xlsx"
    if not name.lower().endswith((".xlsx", ".xls", ".csv")):
        raise HTTPException(status_code=400, detail=f"'{name}' must be an .xlsx, .xls or .csv file.")
    try:
        mapping = parse_email_map_upload(name, await file.read())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not parse mapping file: {e}")
    return {"office_count": len(mapping.get("mappings", {})), "default": mapping.get("default", [])}


@app.post("/api/appointments/email-reports")
async def email_reports_api(
    files: List[UploadFile] = File(...),
    mode: str = Form("draft"),
    sender: str = Form(""),
):
    """
    SOP Step 6 (Part B) — cleanse the uploaded report(s), build one Day Start Excel
    per office, and email each to its mapped recipients via desktop Outlook.
    mode='draft' opens drafts for review; mode='send' sends immediately.
    """
    if not files:
        raise HTTPException(status_code=400, detail="Upload at least one appointment report.")
    if mode not in ("draft", "send"):
        raise HTTPException(status_code=400, detail="mode must be 'draft' or 'send'.")

    payload = []
    for f in files:
        name = f.filename or "report.xlsx"
        if not name.lower().endswith((".xlsx", ".xls", ".csv")):
            raise HTTPException(status_code=400, detail=f"'{name}' must be an .xlsx, .xls or .csv file.")
        payload.append((name, await f.read()))

    try:
        built = build_office_reports(payload)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Report generation failed: {e}")

    try:
        # Outlook COM must run in a worker thread (its own CoInitialize), not on the
        # async event loop — offload it there.
        results = await run_in_threadpool(
            functools.partial(email_office_reports, built["reports"], mode=mode, sender=(sender or None))
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Outlook emailing failed: {e}. Make sure classic Outlook is open and signed in "
                   f"on the machine running the server.",
        )

    sent = sum(1 for r in results if r["ok"])
    return {
        "mode": mode,
        "office_count": len(results),
        "succeeded": sent,
        "failed": len(results) - sent,
        "results": results,
    }


@app.post("/api/new-plan")
def generate_new_plan(req: NewPlanRequest):
    """
    Generate and return an Insurance Plan Breakdown PDF.
    Accepts the full raw JSONs from both portals + optional UI overrides.
    """
    if not req.portal_data or not req.denticon_data:
        raise HTTPException(status_code=400, detail="Missing portal or denticon data")

    # Convert InsOverride pydantic model → plain dict (or None)
    override_dict = req.ins_override.dict() if req.ins_override else None

    # Derive a safe filename from the patient name
    patient_name = (
        req.portal_data
           .get('metlife_data', {})
           .get('patient', {})
           .get('name', 'NewPlan')
           .replace(' ', '_')
    )

    pdf_bytes = generate_new_plan_pdf(
        req.portal_data,
        req.denticon_data,
        ins_override=override_dict,   # ← insName, feeSchedule, relationship applied inside
    )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="Insurance_Plan_{patient_name}.pdf"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        }
    )

if __name__ == "__main__":
    # host="0.0.0.0" makes the server reachable from other machines on the LAN 
    # # (e.g. http://10.30.10.67:8000). Use 127.0.0.1 to restrict to this machine only.
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
    )