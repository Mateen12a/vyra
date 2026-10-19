// VYRA AI Native Virtual Camera for Windows — DirectShow path.
//
// Complete DirectShow source filter for apps that enumerate video capture devices via
// DirectShow/ICreateDevEnum (Chrome, Edge, Discord, OBS, Zoom, legacy apps):
// Full COM InprocServer32 (DllGetClassObject, DllCanUnloadNow, DllRegisterServer,
// IClassFactory), DirectShow Push Source filter (IBaseFilter, IEnumPins, IPin,
// IMemInputPin, IAMStreamConfig, IKsPropertySet with PIN_CATEGORY_CAPTURE, IAMPushSource)
// and a 30 fps push worker thread that calls FillBuffer -> Receive, streaming
// 1280x720 BGR24 from Local\VyraCamSharedMem (written by vyra_cam_bridge.py)
// or a built-in animated test pattern when no producer is attached.
//
// Microsoft Store / UWP apps (WhatsApp Desktop from the Store, Windows Camera, Teams)
// enumerate via Media Foundation's virtual-camera API + Frame Server instead. Those apps
// need a genuine Media Foundation media source COM class — a different deliverable; see
// mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md next to this file.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <dshow.h>
#include <dvdmedia.h>
#include <olectl.h>
#include <initguid.h>
#include <stdint.h>
#include <stdio.h>
#include <strsafe.h>

#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "uuid.lib")

// NOTE ON “WORKS IN ALL WINDOWS APPS”:
// This file provides the DirectShow capture source only. It covers apps that enumerate
// sources via DirectShow/ICreateDevEnum (Chrome/Edge, Discord, OBSVirtual, most Win32 apps).
// Microsoft Store apps and UWP/UWP-type hosts (WhatsApp Desktop from the Store, Windows
// Camera) enumerate via Media Foundation + the Frame Server instead. Reaching THOSE apps
// requires a genuine Media Foundation media source registered with Microsoft's
// Media Foundation virtual camera API
// (Windows 11 22000+; Media VirtualCamera only).
// See mf-virtual-camera/BUILD-VYRA-MF-VIRTUAL-CAMERA.md for the real path: it must be
// built with MSVC + Windows SDK 22000+ (mfvirtualcamera.h) and registered as an
// IMFMediaSource COM CLSID — this DShow filter CLSID can NOT serve as sourceId there.
// That build is separate from this file on purpose so the two paths stay independently verifiable.

// {8E4A9F21-7C3B-4D8A-9E12-5F0B2C6D8A41}
DEFINE_GUID(CLSID_VyraVirtualCamera,
    0x8e4a9f21, 0x7c3b, 0x4d8a, 0x9e, 0x12, 0x5f, 0x0b, 0x2c, 0x6d, 0x8a, 0x41);

static const wchar_t* kCameraName = L"VYRA AI Camera";
static const wchar_t* kClsidString = L"{8E4A9F21-7C3B-4D8A-9E12-5F0B2C6D8A41}";
static const wchar_t* kShmName = L"Local\\VyraCamSharedMem";
static const int kWidth = 1280;
static const int kHeight = 720;
static const int kBpp = 3;
static const int kFrameBytes = kWidth * kHeight * kBpp;
static const LONGLONG kFrameInterval = 333333LL; // 30 fps in 100-ns units

static HMODULE g_hModule = NULL;
static volatile LONG g_cDllRef = 0;

#pragma pack(push, 1)
struct VyraShmHeader {
    char magic[4];       // "VYRA"
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t seq;
    uint64_t timestamp_ms;
};
#pragma pack(pop)

// Reads the latest 1280x720 BGR24 frame from Local\VyraCamSharedMem or renders a live test pattern
void FillVyraFrame(uint8_t* dst, size_t dstLen, uint32_t frameNumber) {
    if (!dst || dstLen < (size_t)kFrameBytes) return;

    HANDLE hMap = OpenFileMappingW(FILE_MAP_READ, FALSE, kShmName);
    if (hMap) {
        const uint8_t* view = (const uint8_t*)MapViewOfFile(
            hMap, FILE_MAP_READ, 0, 0, sizeof(VyraShmHeader) + kFrameBytes);
        if (view) {
            const VyraShmHeader* hdr = (const VyraShmHeader*)view;
            if (memcmp(hdr->magic, "VYRA", 4) == 0 &&
                hdr->width == kWidth &&
                hdr->height == kHeight &&
                hdr->seq > 0) {
                memcpy(dst, view + sizeof(VyraShmHeader), kFrameBytes);
                UnmapViewOfFile(view);
                CloseHandle(hMap);
                return;
            }
            UnmapViewOfFile(view);
        }
        CloseHandle(hMap);
    }

    // Animated test pattern (dark studio background + moving VYRA orange bar)
    for (int y = 0; y < kHeight; ++y) {
        uint8_t* row = dst + (y * kWidth * kBpp);
        for (int x = 0; x < kWidth; ++x) {
            row[x * 3 + 0] = 14; // B
            row[x * 3 + 1] = 10; // G
            row[x * 3 + 2] = 10; // R
        }
    }
    int barY = kHeight / 2;
    int pulseX = (frameNumber * 12) % (kWidth - 240);
    for (int y = barY - 8; y < barY + 8; ++y) {
        uint8_t* row = dst + (y * kWidth * kBpp);
        for (int x = pulseX; x < pulseX + 240; ++x) {
            row[x * 3 + 0] = 43;  // B
            row[x * 3 + 1] = 107; // G
            row[x * 3 + 2] = 255; // R (#FF6B2B)
        }
    }
}

static void PopulateMediaType(AM_MEDIA_TYPE* pmt) {
    if (!pmt) return;
    ZeroMemory(pmt, sizeof(AM_MEDIA_TYPE));
    VIDEOINFOHEADER* pvi = (VIDEOINFOHEADER*)CoTaskMemAlloc(sizeof(VIDEOINFOHEADER));
    if (!pvi) return;
    ZeroMemory(pvi, sizeof(VIDEOINFOHEADER));
    pvi->AvgTimePerFrame = kFrameInterval;
    pvi->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    pvi->bmiHeader.biWidth = kWidth;
    pvi->bmiHeader.biHeight = kHeight; // bottom-up BGR24
    pvi->bmiHeader.biPlanes = 1;
    pvi->bmiHeader.biBitCount = 24;
    pvi->bmiHeader.biCompression = BI_RGB;
    pvi->bmiHeader.biSizeImage = kFrameBytes;

    pmt->majortype = MEDIATYPE_Video;
    pmt->subtype = MEDIASUBTYPE_RGB24;
    pmt->bFixedSizeSamples = TRUE;
    pmt->bTemporalCompression = FALSE;
    pmt->lSampleSize = kFrameBytes;
    pmt->formattype = FORMAT_VideoInfo;
    pmt->cbFormat = sizeof(VIDEOINFOHEADER);
    pmt->pbFormat = (BYTE*)pvi;
}

static void FreeMediaTypeFields(AM_MEDIA_TYPE* pmt) {
    if (!pmt) return;
    if (pmt->cbFormat != 0 && pmt->pbFormat) {
        CoTaskMemFree(pmt->pbFormat);
        pmt->cbFormat = 0;
        pmt->pbFormat = NULL;
    }
    if (pmt->pUnk) {
        pmt->pUnk->Release();
        pmt->pUnk = NULL;
    }
}

static void DeleteMediaType(AM_MEDIA_TYPE* pmt) {
    if (!pmt) return;
    FreeMediaTypeFields(pmt);
    CoTaskMemFree(pmt);
}

class VyraCameraFilter;

// ---------- IEnumMediaTypes implementation ----------
class VyraEnumMediaTypes : public IEnumMediaTypes {
    volatile LONG m_cRef;
    ULONG m_pos;
public:
    VyraEnumMediaTypes(ULONG pos = 0) : m_cRef(1), m_pos(pos) { InterlockedIncrement(&g_cDllRef); }
    ~VyraEnumMediaTypes() { InterlockedDecrement(&g_cDllRef); }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IEnumMediaTypes) {
            *ppv = static_cast<IEnumMediaTypes*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&m_cRef);
        if (r == 0) delete this;
        return r;
    }
    STDMETHODIMP Next(ULONG cMediaTypes, AM_MEDIA_TYPE** ppMediaTypes, ULONG* pcFetched) override {
        if (!ppMediaTypes) return E_POINTER;
        if (cMediaTypes == 0) return E_INVALIDARG;
        ULONG fetched = 0;
        if (m_pos == 0 && cMediaTypes >= 1) {
            AM_MEDIA_TYPE* pmt = (AM_MEDIA_TYPE*)CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE));
            if (!pmt) return E_OUTOFMEMORY;
            PopulateMediaType(pmt);
            ppMediaTypes[0] = pmt;
            m_pos = 1;
            fetched = 1;
        }
        if (pcFetched) *pcFetched = fetched;
        return (fetched == cMediaTypes) ? S_OK : S_FALSE;
    }
    STDMETHODIMP Skip(ULONG cMediaTypes) override {
        m_pos += cMediaTypes;
        return (m_pos <= 1) ? S_OK : S_FALSE;
    }
    STDMETHODIMP Reset() override { m_pos = 0; return S_OK; }
    STDMETHODIMP Clone(IEnumMediaTypes** ppEnum) override {
        if (!ppEnum) return E_POINTER;
        *ppEnum = new VyraEnumMediaTypes(m_pos);
        return *ppEnum ? S_OK : E_OUTOFMEMORY;
    }
};

// ---------- Output Pin implementation (IPin, IAMStreamConfig, IKsPropertySet, IAMPushSource) ----------
class VyraOutputPin : public IPin, public IAMStreamConfig, public IKsPropertySet, public IAMPushSource {
    volatile LONG m_cRef;
    VyraCameraFilter* m_pFilter;
    IPin* m_pConnectedPin;
    IMemInputPin* m_pMemInputPin;
    IMemAllocator* m_pAllocator;
    AM_MEDIA_TYPE m_mt;
    HANDLE m_hThread;
    HANDLE m_hStopEvent;
    uint32_t m_frameCount;

public:
    VyraOutputPin(VyraCameraFilter* pFilter)
        : m_cRef(1), m_pFilter(pFilter), m_pConnectedPin(NULL),
          m_pMemInputPin(NULL), m_pAllocator(NULL), m_hThread(NULL), m_frameCount(0) {
        InterlockedIncrement(&g_cDllRef);
        PopulateMediaType(&m_mt);
        m_hStopEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
    }

    ~VyraOutputPin() {
        StopStreamingThread();
        Disconnect();
        FreeMediaTypeFields(&m_mt);
        if (m_hStopEvent) CloseHandle(m_hStopEvent);
        InterlockedDecrement(&g_cDllRef);
    }

    // FillBuffer populates a DirectShow IMediaSample with the next 1280x720 frame and timestamps
    HRESULT FillBuffer(IMediaSample* pSample) {
        if (!pSample) return E_POINTER;
        BYTE* pData = NULL;
        HRESULT hr = pSample->GetPointer(&pData);
        if (FAILED(hr) || !pData) return hr;
        long cbData = pSample->GetSize();
        if (cbData < kFrameBytes) return E_FAIL;

        FillVyraFrame(pData, (size_t)cbData, m_frameCount);
        pSample->SetActualDataLength(kFrameBytes);
        pSample->SetSyncPoint(TRUE);

        REFERENCE_TIME rtStart = (REFERENCE_TIME)m_frameCount * kFrameInterval;
        REFERENCE_TIME rtStop = rtStart + kFrameInterval;
        pSample->SetTime(&rtStart, &rtStop);
        m_frameCount++;
        return S_OK;
    }

    static DWORD WINAPI PushThreadProc(LPVOID lpParam) {
        VyraOutputPin* self = static_cast<VyraOutputPin*>(lpParam);
        while (WaitForSingleObject(self->m_hStopEvent, 33) == WAIT_TIMEOUT) {
            if (!self->m_pAllocator || !self->m_pMemInputPin) continue;
            IMediaSample* pSample = NULL;
            HRESULT hr = self->m_pAllocator->GetBuffer(&pSample, NULL, NULL, 0);
            if (SUCCEEDED(hr) && pSample) {
                if (SUCCEEDED(self->FillBuffer(pSample))) {
                    self->m_pMemInputPin->Receive(pSample);
                }
                pSample->Release();
            }
        }
        return 0;
    }

    void StartStreamingThread() {
        if (m_hThread) return;
        if (m_pAllocator) m_pAllocator->Commit();
        m_frameCount = 0;
        ResetEvent(m_hStopEvent);
        m_hThread = CreateThread(NULL, 0, PushThreadProc, this, 0, NULL);
    }

    void StopStreamingThread() {
        if (m_hThread) {
            SetEvent(m_hStopEvent);
            WaitForSingleObject(m_hThread, 2000);
            CloseHandle(m_hThread);
            m_hThread = NULL;
        }
        if (m_pAllocator) m_pAllocator->Decommit();
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IPin) *ppv = static_cast<IPin*>(this);
        else if (riid == IID_IAMStreamConfig) *ppv = static_cast<IAMStreamConfig*>(this);
        else if (riid == IID_IKsPropertySet) *ppv = static_cast<IKsPropertySet*>(this);
        else if (riid == IID_IAMPushSource || riid == IID_IAMLatency) *ppv = static_cast<IAMPushSource*>(this);
        else { *ppv = NULL; return E_NOINTERFACE; }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&m_cRef);
        if (r == 0) delete this;
        return r;
    }

    // IPin
    STDMETHODIMP Connect(IPin* pReceivePin, const AM_MEDIA_TYPE* pmt) override {
        if (!pReceivePin) return E_POINTER;
        if (m_pConnectedPin) return VFW_E_ALREADY_CONNECTED;
        if (pmt && pmt->majortype != GUID_NULL && pmt->majortype != MEDIATYPE_Video) {
            return VFW_E_TYPE_NOT_ACCEPTED;
        }
        HRESULT hr = pReceivePin->ReceiveConnection(static_cast<IPin*>(this), &m_mt);
        if (FAILED(hr)) return hr;

        hr = pReceivePin->QueryInterface(IID_IMemInputPin, (void**)&m_pMemInputPin);
        if (FAILED(hr) || !m_pMemInputPin) {
            pReceivePin->Disconnect();
            return hr;
        }
        hr = m_pMemInputPin->GetAllocator(&m_pAllocator);
        if (FAILED(hr) || !m_pAllocator) {
            m_pMemInputPin->Release();
            m_pMemInputPin = NULL;
            pReceivePin->Disconnect();
            return hr;
        }
        ALLOCATOR_PROPERTIES propReq = { 4, kFrameBytes, 1, 0 };
        ALLOCATOR_PROPERTIES propAct = { 0 };
        m_pAllocator->SetProperties(&propReq, &propAct);
        m_pMemInputPin->NotifyAllocator(m_pAllocator, FALSE);

        m_pConnectedPin = pReceivePin;
        m_pConnectedPin->AddRef();
        return S_OK;
    }
    STDMETHODIMP ReceiveConnection(IPin*, const AM_MEDIA_TYPE*) override { return E_UNEXPECTED; }
    STDMETHODIMP Disconnect() override {
        StopStreamingThread();
        if (m_pAllocator) { m_pAllocator->Release(); m_pAllocator = NULL; }
        if (m_pMemInputPin) { m_pMemInputPin->Release(); m_pMemInputPin = NULL; }
        if (m_pConnectedPin) { m_pConnectedPin->Release(); m_pConnectedPin = NULL; return S_OK; }
        return S_FALSE;
    }
    STDMETHODIMP ConnectedTo(IPin** pPin) override {
        if (!pPin) return E_POINTER;
        *pPin = m_pConnectedPin;
        if (!m_pConnectedPin) return VFW_E_NOT_CONNECTED;
        m_pConnectedPin->AddRef();
        return S_OK;
    }
    STDMETHODIMP ConnectionMediaType(AM_MEDIA_TYPE* pmt) override {
        if (!pmt) return E_POINTER;
        if (!m_pConnectedPin) return VFW_E_NOT_CONNECTED;
        PopulateMediaType(pmt);
        return S_OK;
    }
    STDMETHODIMP QueryPinInfo(PIN_INFO* pInfo) override;
    STDMETHODIMP QueryDirection(PIN_DIRECTION* pPinDir) override {
        if (!pPinDir) return E_POINTER;
        *pPinDir = PINDIR_OUTPUT;
        return S_OK;
    }
    STDMETHODIMP QueryId(LPWSTR* Id) override {
        if (!Id) return E_POINTER;
        *Id = (LPWSTR)CoTaskMemAlloc(16 * sizeof(wchar_t));
        if (!*Id) return E_OUTOFMEMORY;
        StringCchCopyW(*Id, 16, L"Capture");
        return S_OK;
    }
    STDMETHODIMP QueryAccept(const AM_MEDIA_TYPE* pmt) override {
        if (!pmt) return E_POINTER;
        return (pmt->majortype == MEDIATYPE_Video && pmt->subtype == MEDIASUBTYPE_RGB24) ? S_OK : S_FALSE;
    }
    STDMETHODIMP EnumMediaTypes(IEnumMediaTypes** ppEnum) override {
        if (!ppEnum) return E_POINTER;
        *ppEnum = new VyraEnumMediaTypes(0);
        return *ppEnum ? S_OK : E_OUTOFMEMORY;
    }
    STDMETHODIMP QueryInternalConnections(IPin**, ULONG*) override { return E_NOTIMPL; }
    STDMETHODIMP EndOfStream() override { return S_OK; }
    STDMETHODIMP BeginFlush() override { return S_OK; }
    STDMETHODIMP EndFlush() override { return S_OK; }
    STDMETHODIMP NewSegment(REFERENCE_TIME, REFERENCE_TIME, double) override { return S_OK; }

    // IAMStreamConfig
    STDMETHODIMP SetFormat(AM_MEDIA_TYPE* pmt) override {
        if (!pmt) return E_POINTER;
        if (pmt->majortype != MEDIATYPE_Video || pmt->subtype != MEDIASUBTYPE_RGB24) return VFW_E_INVALIDMEDIATYPE;
        return S_OK;
    }
    STDMETHODIMP GetFormat(AM_MEDIA_TYPE** ppmt) override {
        if (!ppmt) return E_POINTER;
        *ppmt = (AM_MEDIA_TYPE*)CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE));
        if (!*ppmt) return E_OUTOFMEMORY;
        PopulateMediaType(*ppmt);
        return S_OK;
    }
    STDMETHODIMP GetNumberOfCapabilities(int* piCount, int* piSize) override {
        if (!piCount || !piSize) return E_POINTER;
        *piCount = 1;
        *piSize = sizeof(VIDEO_STREAM_CONFIG_CAPS);
        return S_OK;
    }
    STDMETHODIMP GetStreamCaps(int iIndex, AM_MEDIA_TYPE** ppmt, BYTE* pSCC) override {
        if (!ppmt || !pSCC) return E_POINTER;
        if (iIndex < 0) return E_INVALIDARG;
        if (iIndex > 0) return S_FALSE;
        *ppmt = (AM_MEDIA_TYPE*)CoTaskMemAlloc(sizeof(AM_MEDIA_TYPE));
        if (!*ppmt) return E_OUTOFMEMORY;
        PopulateMediaType(*ppmt);

        VIDEO_STREAM_CONFIG_CAPS* pvscc = reinterpret_cast<VIDEO_STREAM_CONFIG_CAPS*>(pSCC);
        ZeroMemory(pvscc, sizeof(VIDEO_STREAM_CONFIG_CAPS));
        pvscc->guid = FORMAT_VideoInfo;
        pvscc->MinFrameInterval = kFrameInterval;
        pvscc->MaxFrameInterval = kFrameInterval;
        pvscc->InputSize.cx = kWidth;
        pvscc->InputSize.cy = kHeight;
        pvscc->MinOutputSize.cx = kWidth;
        pvscc->MinOutputSize.cy = kHeight;
        pvscc->MaxOutputSize.cx = kWidth;
        pvscc->MaxOutputSize.cy = kHeight;
        pvscc->MinBitsPerSecond = kFrameBytes * 8 * 30;
        pvscc->MaxBitsPerSecond = kFrameBytes * 8 * 30;
        return S_OK;
    }

    // IKsPropertySet (Required so Windows/Chrome/Zoom classify this pin as PIN_CATEGORY_CAPTURE)
    STDMETHODIMP Set(REFGUID, DWORD, LPVOID, DWORD, LPVOID, DWORD) override { return E_NOTIMPL; }
    STDMETHODIMP Get(REFGUID guidPropSet, DWORD dwPropID, LPVOID, DWORD, LPVOID pPropData, DWORD cbPropData, DWORD* pcbReturned) override {
        if (guidPropSet != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (dwPropID != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (pPropData == NULL && pcbReturned == NULL) return E_POINTER;
        if (pcbReturned) *pcbReturned = sizeof(GUID);
        if (pPropData == NULL) return S_OK;
        if (cbPropData < sizeof(GUID)) return E_UNEXPECTED;
        *(GUID*)pPropData = PIN_CATEGORY_CAPTURE;
        return S_OK;
    }
    STDMETHODIMP QuerySupported(REFGUID guidPropSet, DWORD dwPropID, DWORD* pTypeSupport) override {
        if (guidPropSet != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (dwPropID != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (pTypeSupport) *pTypeSupport = KSPROPERTY_SUPPORT_GET;
        return S_OK;
    }

    // IAMPushSource
    STDMETHODIMP GetLatency(REFERENCE_TIME* prtLatency) override {
        if (!prtLatency) return E_POINTER;
        *prtLatency = kFrameInterval;
        return S_OK;
    }
    STDMETHODIMP GetPushSourceFlags(ULONG* pFlags) override {
        if (!pFlags) return E_POINTER;
        *pFlags = 0;
        return S_OK;
    }
    STDMETHODIMP SetPushSourceFlags(ULONG) override { return E_NOTIMPL; }
    STDMETHODIMP SetStreamOffset(REFERENCE_TIME) override { return S_OK; }
    STDMETHODIMP GetStreamOffset(REFERENCE_TIME* prtOffset) override {
        if (!prtOffset) return E_POINTER;
        *prtOffset = 0;
        return S_OK;
    }
    STDMETHODIMP GetMaxStreamOffset(REFERENCE_TIME* prtMaxOffset) override {
        if (!prtMaxOffset) return E_POINTER;
        *prtMaxOffset = 0;
        return S_OK;
    }
    STDMETHODIMP SetMaxStreamOffset(REFERENCE_TIME) override { return S_OK; }
};

// ---------- IEnumPins implementation ----------
class VyraEnumPins : public IEnumPins {
    volatile LONG m_cRef;
    VyraOutputPin* m_pPin;
    ULONG m_pos;
public:
    VyraEnumPins(VyraOutputPin* pPin, ULONG pos = 0) : m_cRef(1), m_pPin(pPin), m_pos(pos) {
        InterlockedIncrement(&g_cDllRef);
        if (m_pPin) m_pPin->AddRef();
    }
    ~VyraEnumPins() {
        if (m_pPin) m_pPin->Release();
        InterlockedDecrement(&g_cDllRef);
    }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IEnumPins) {
            *ppv = static_cast<IEnumPins*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&m_cRef);
        if (r == 0) delete this;
        return r;
    }
    STDMETHODIMP Next(ULONG cPins, IPin** ppPins, ULONG* pcFetched) override {
        if (!ppPins) return E_POINTER;
        ULONG fetched = 0;
        if (m_pos == 0 && cPins >= 1 && m_pPin) {
            ppPins[0] = static_cast<IPin*>(m_pPin);
            m_pPin->AddRef();
            m_pos = 1;
            fetched = 1;
        }
        if (pcFetched) *pcFetched = fetched;
        return (fetched == cPins) ? S_OK : S_FALSE;
    }
    STDMETHODIMP Skip(ULONG cPins) override { m_pos += cPins; return (m_pos <= 1) ? S_OK : S_FALSE; }
    STDMETHODIMP Reset() override { m_pos = 0; return S_OK; }
    STDMETHODIMP Clone(IEnumPins** ppEnum) override {
        if (!ppEnum) return E_POINTER;
        *ppEnum = new VyraEnumPins(m_pPin, m_pos);
        return *ppEnum ? S_OK : E_OUTOFMEMORY;
    }
};

// ---------- IBaseFilter + IAMFilterMiscFlags implementation ----------
class VyraCameraFilter : public IBaseFilter, public IAMFilterMiscFlags {
    volatile LONG m_cRef;
    FILTER_STATE m_state;
    IFilterGraph* m_pGraph;
    IReferenceClock* m_pClock;
    VyraOutputPin* m_pPin;
public:
    VyraCameraFilter()
        : m_cRef(1), m_state(State_Stopped), m_pGraph(NULL), m_pClock(NULL) {
        InterlockedIncrement(&g_cDllRef);
        m_pPin = new VyraOutputPin(this);
    }
    ~VyraCameraFilter() {
        if (m_pPin) { m_pPin->StopStreamingThread(); m_pPin->Release(); }
        if (m_pClock) m_pClock->Release();
        InterlockedDecrement(&g_cDllRef);
    }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IPersist || riid == IID_IMediaFilter || riid == IID_IBaseFilter) {
            *ppv = static_cast<IBaseFilter*>(this);
        } else if (riid == IID_IAMFilterMiscFlags) {
            *ppv = static_cast<IAMFilterMiscFlags*>(this);
        } else {
            *ppv = NULL;
            return E_NOINTERFACE;
        }
        AddRef();
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&m_cRef);
        if (r == 0) delete this;
        return r;
    }

    // IPersist
    STDMETHODIMP GetClassID(CLSID* pClsID) override {
        if (!pClsID) return E_POINTER;
        *pClsID = CLSID_VyraVirtualCamera;
        return S_OK;
    }

    // IMediaFilter
    STDMETHODIMP Stop() override {
        m_state = State_Stopped;
        if (m_pPin) m_pPin->StopStreamingThread();
        return S_OK;
    }
    STDMETHODIMP Pause() override {
        m_state = State_Paused;
        return S_OK;
    }
    STDMETHODIMP Run(REFERENCE_TIME) override {
        m_state = State_Running;
        if (m_pPin) m_pPin->StartStreamingThread();
        return S_OK;
    }
    STDMETHODIMP GetState(DWORD, FILTER_STATE* State) override {
        if (!State) return E_POINTER;
        *State = m_state;
        return S_OK;
    }
    STDMETHODIMP SetSyncSource(IReferenceClock* pClock) override {
        if (m_pClock) m_pClock->Release();
        m_pClock = pClock;
        if (m_pClock) m_pClock->AddRef();
        return S_OK;
    }
    STDMETHODIMP GetSyncSource(IReferenceClock** pClock) override {
        if (!pClock) return E_POINTER;
        *pClock = m_pClock;
        if (m_pClock) m_pClock->AddRef();
        return S_OK;
    }

    // IBaseFilter
    STDMETHODIMP EnumPins(IEnumPins** ppEnum) override {
        if (!ppEnum) return E_POINTER;
        *ppEnum = new VyraEnumPins(m_pPin, 0);
        return *ppEnum ? S_OK : E_OUTOFMEMORY;
    }
    STDMETHODIMP FindPin(LPCWSTR Id, IPin** ppPin) override {
        if (!ppPin) return E_POINTER;
        if (Id && wcscmp(Id, L"Capture") == 0) {
            *ppPin = static_cast<IPin*>(m_pPin);
            m_pPin->AddRef();
            return S_OK;
        }
        *ppPin = NULL;
        return VFW_E_NOT_FOUND;
    }
    STDMETHODIMP QueryFilterInfo(FILTER_INFO* pInfo) override {
        if (!pInfo) return E_POINTER;
        StringCchCopyW(pInfo->achName, MAX_FILTER_NAME, kCameraName);
        pInfo->pGraph = m_pGraph;
        if (m_pGraph) m_pGraph->AddRef();
        return S_OK;
    }
    STDMETHODIMP JoinFilterGraph(IFilterGraph* pGraph, LPCWSTR) override {
        m_pGraph = pGraph;
        return S_OK;
    }
    STDMETHODIMP QueryVendorInfo(LPWSTR* pVendorInfo) override {
        if (!pVendorInfo) return E_POINTER;
        *pVendorInfo = (LPWSTR)CoTaskMemAlloc(32 * sizeof(wchar_t));
        if (!*pVendorInfo) return E_OUTOFMEMORY;
        StringCchCopyW(*pVendorInfo, 32, L"VYRA AI");
        return S_OK;
    }

    // IAMFilterMiscFlags
    STDMETHODIMP_(ULONG) GetMiscFlags() override {
        return AM_FILTER_MISC_FLAGS_IS_SOURCE;
    }
};

STDMETHODIMP VyraOutputPin::QueryPinInfo(PIN_INFO* pInfo) {
    if (!pInfo) return E_POINTER;
    pInfo->pFilter = static_cast<IBaseFilter*>(m_pFilter);
    if (m_pFilter) m_pFilter->AddRef();
    pInfo->dir = PINDIR_OUTPUT;
    StringCchCopyW(pInfo->achName, MAX_PIN_NAME, L"Capture");
    return S_OK;
}

// ---------- IClassFactory + COM DLL Entrypoints ----------
class VyraClassFactory : public IClassFactory {
    volatile LONG m_cRef;
public:
    VyraClassFactory() : m_cRef(1) { InterlockedIncrement(&g_cDllRef); }
    ~VyraClassFactory() { InterlockedDecrement(&g_cDllRef); }

    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&m_cRef); }
    STDMETHODIMP_(ULONG) Release() override {
        ULONG r = InterlockedDecrement(&m_cRef);
        if (r == 0) delete this;
        return r;
    }
    STDMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = NULL;
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;
        VyraCameraFilter* filter = new VyraCameraFilter();
        if (!filter) return E_OUTOFMEMORY;
        HRESULT hr = filter->QueryInterface(riid, ppv);
        filter->Release();
        return hr;
    }
    STDMETHODIMP LockServer(BOOL fLock) override {
        if (fLock) InterlockedIncrement(&g_cDllRef);
        else InterlockedDecrement(&g_cDllRef);
        return S_OK;
    }
};

STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, LPVOID* ppv) {
    if (!ppv) return E_POINTER;
    *ppv = NULL;
    if (rclsid != CLSID_VyraVirtualCamera) return CLASS_E_CLASSNOTAVAILABLE;
    VyraClassFactory* factory = new VyraClassFactory();
    if (!factory) return E_OUTOFMEMORY;
    HRESULT hr = factory->QueryInterface(riid, ppv);
    factory->Release();
    return hr;
}

STDAPI DllCanUnloadNow() {
    return (g_cDllRef == 0) ? S_OK : S_FALSE;
}

BOOL APIENTRY DllMain(HMODULE hModule, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hModule = hModule;
        DisableThreadLibraryCalls(hModule);
    }
    return TRUE;
}

STDAPI DllRegisterServer() {
    wchar_t modulePath[MAX_PATH];
    if (!GetModuleFileNameW(g_hModule, modulePath, MAX_PATH)) {
        return HRESULT_FROM_WIN32(GetLastError());
    }

    const wchar_t* catStr = L"{860BB310-5D01-11D0-BD3B-00A0C911CE86}"; // CLSID_VideoInputDeviceCategory
    wchar_t keyPath[256];
    HKEY hKey = NULL;

    // 1. Register COM InprocServer32 under HKCU\Software\Classes\CLSID
    StringCchPrintfW(keyPath, 256, L"Software\\Classes\\CLSID\\%s", kClsidString);
    if (RegCreateKeyExW(HKEY_CURRENT_USER, keyPath, 0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL) != ERROR_SUCCESS)
        return E_FAIL;
    RegSetValueExW(hKey, NULL, 0, REG_SZ, (const BYTE*)kCameraName, (DWORD)((wcslen(kCameraName) + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);

    StringCchPrintfW(keyPath, 256, L"Software\\Classes\\CLSID\\%s\\InprocServer32", kClsidString);
    if (RegCreateKeyExW(HKEY_CURRENT_USER, keyPath, 0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL) != ERROR_SUCCESS)
        return E_FAIL;
    RegSetValueExW(hKey, NULL, 0, REG_SZ, (const BYTE*)modulePath, (DWORD)((wcslen(modulePath) + 1) * sizeof(wchar_t)));
    const wchar_t* model = L"Both";
    RegSetValueExW(hKey, L"ThreadingModel", 0, REG_SZ, (const BYTE*)model, (DWORD)((wcslen(model) + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);

    // 2. Register in DirectShow VideoInputDeviceCategory under HKCU
    StringCchPrintfW(keyPath, 256, L"Software\\Classes\\CLSID\\%s\\Instance\\%s", catStr, kClsidString);
    if (RegCreateKeyExW(HKEY_CURRENT_USER, keyPath, 0, NULL, 0, KEY_WRITE, NULL, &hKey, NULL) != ERROR_SUCCESS)
        return E_FAIL;
    RegSetValueExW(hKey, L"FriendlyName", 0, REG_SZ, (const BYTE*)kCameraName, (DWORD)((wcslen(kCameraName) + 1) * sizeof(wchar_t)));
    RegSetValueExW(hKey, L"CLSID", 0, REG_SZ, (const BYTE*)kClsidString, (DWORD)((wcslen(kClsidString) + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);

    return S_OK;
}

STDAPI DllUnregisterServer() {
    const wchar_t* catStr = L"{860BB310-5D01-11D0-BD3B-00A0C911CE86}";
    wchar_t keyPath[256];

    StringCchPrintfW(keyPath, 256, L"Software\\Classes\\CLSID\\%s\\Instance\\%s", catStr, kClsidString);
    RegDeleteTreeW(HKEY_CURRENT_USER, keyPath);

    StringCchPrintfW(keyPath, 256, L"Software\\Classes\\CLSID\\%s", kClsidString);
    RegDeleteTreeW(HKEY_CURRENT_USER, keyPath);
    return S_OK;
}
