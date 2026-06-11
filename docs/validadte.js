/*******************************************************************************
** Validaciones para las paginas del dte, tanto internet como intranet
** 
** 
**   Fecha  Descripcion                                        Responsable
** 30-01-04 Corrige funcion ad_mod_empresa saca campo desuso   Consuelo Martinez
** 28-09-04 Agrega opcion Ver Empr. Emis. en ee_revisa_ver_emp Consuelo Martinez
** 28-10-04 Cambia nombres archivo en la fx. ee_revisa_ver_emp Consuelo Martinez
** 07-03-05 Agrega funcion pf_confirma peque facturadores      Consuelo Martinez
** 27-09-05 Corrige funcion eu_enrola_usuario para mipyme      Consuelo Martinez
** 16-11-06 Agrega set13 lc exento                             Consuelo Martinez
** 29-02-08 Corrige validacion para el año bisiesto            Consuelo Martinez
** 25-08-08 Agrega fx deshabilitaSeleccion, no permite selec-  Consuelo Martinez
**          cionar el texto de la pagina
** 08-09-09 Agrega validacion privilegio consulta en:          Consuelo Martinez
**          eu_enrola_usuario, ee_enrola_usuario, validacion
**          validaDocto888y889 exclusion de doctos 888 y 889
** 15-01-10 Vuelve atras fx ee_revisa_ver_emp por no pasar la  Consuelo Martinez
**          version definitiva
** 10-03-10 Agrega validacion de registro en eu_enrola_usuario Consuelo Martinez
** 30-06-10 Permite ingresar fecha < 2 meses en ing. empresa y Consuelo Martinez
**          documentos fxs validaFecha y validafecha_aut
** 09-08-12 Valida cantidad de timbrajes y cantidades de cré - Roxana Lobera
            dito fiscal                                       
** 09-05-13 Validación cuando no posee actividades económicas 
            afectas a IVA                                      Roxana lobera
** 27-10-14 Validación cantidad de doc sin CF y con ajuste     Roxana Lobera 
** 14-09-15 Envia mensaje cuando el factor es < 1              Roxana Lobera 
** 30-10-15 aumenta maximo de folio a 9999999                  Roxana Lobera 
** 01-02-16 SDI-40619 OT cantidad nula doc sin CF              Roxana Lobera 
*** 02-11-22 SDI-216848   Cambio servicios a afectos - Descarga de Folios de DTE                       RLL
** 08-11-23 SDI-244645 Permitir descarga de folios de Factura de Compra a Sociedades de Profesionales      RLL
*******************************************************************************/
function deshabilitaSeleccion()
{
  document.onselectstart=new Function ("return false")
  if (window.sidebar)
  {
    document.onmousedown = disableselect
    document.onclick = reEnable
  }
}


function esDv(obj)
{
  if ( obj.length!=1 )
    return false;

  if ( (obj.charAt(0)>='0' && obj.charAt(0)<='9') || obj.charAt(0)=='k' || obj.charAt(0)=='K')
    return true;

  return false;
}

function RutDvModulo11(objRut,objDv)
{
  // Funcion que realiza una confirmacion basica de un rut
  // false: El RUT no es valido.
  // true : RUT valido
  // calcular el d\355gito verificador

  var dvr = '0';
  suma = 0;
  mul  = 2;

  for (i= objRut.length - 1; i >= 0; i--)
  {
    suma = suma + objRut.charAt(i) * mul;
    if (mul == 7)
      mul = 2;
    else
      mul++;
  }

  res = suma % 11;
  if (res==1)
    dvr = 'k';
  else if (res==0)
    dvr = '0';
  else
  {
    dvi = 11-res;
    dvr = dvi + "";
  }

  // verificar que el digito verificador corresponde
  if (dvr != objDv.charAt(0).toLowerCase())
  {       return false;   }

  return true;
}

function esBlanco(obj)
{
  if(obj.value=="")
  {
    return true;
  }
  else
  {
    var largo=obj.length;
    for (var i=0;i<largo;i++)
    {
      if(obj.charAt(i)!=' ')
        return false;
    }
    return true;
  }
}

function esNatural(obj)
{
  if (esBlanco(obj)==true)
    return false;
  var largo=obj.length;
  for (var i=0;i<largo;i++)
  {
    if ( obj.charAt(i)<'0' || obj.charAt(i)>'9')
      return false;
  }
  return true;
}

function largoSinBlancos (obj,minimo,maximo)
{
  //Funcion que valida el largo de obj >= minimo y <=maximo
  var largoObj=0;
  var largo=obj.length;
  if (largo>0)
  {
    for (var i=0;i<largo;i++)
    {
      if(obj.charAt(i)!=' ')
        largoObj=largoObj+1;
      else
        return false;
    }
  }

  if (largoObj>=minimo && largoObj<=maximo)
    return true;
  else
    return false;
}

function ValRutDv(objRut,objDv)
{
  if (esBlanco(objRut)==true && esBlanco(objDv)==true )
  {
    alert ("Ingrese un RUT y un DV");
    return false;
  }

  if (esNatural(objRut)==false)
  {
    alert("El Rut debe contener solo números (sin puntos).");
    return false;
  }

  if(largoSinBlancos(objRut,1,10)==false)
  {
    alert("Rut debe tener al menos 1 caracter y a lo mas 10. No debe contener caracteres blancos");
    return false;
  }

  if (esBlanco(objDv)==false)
    if (esDv(objDv)==false)
    {
      alert("Ingrese un n\372mero o letra K como dígito verificador.");
      return false;
    }

  if (esBlanco(objRut)==true && esBlanco(objDv)==false)
  {
    alert ("Debe digitar el cuerpo del Rut");
    return false;
  }

  if (esBlanco(objDv)==false)
    if( RutDvModulo11(objRut,objDv)==false )
    {
      alert("RUT incorrecto seg\372n M\363dulo 11")
      return false;
    }

  if (esBlanco(objRut)==false && esBlanco(objDv)==true)
  {
    alert("No ha ingresado el dígito verificador");
    return false;
  }
  return true;
}

function valida_area()
{
  area0=document.form1.AREA[0].checked;
  area1=document.form1.AREA[1].checked;

  if(!area0 && !area1 )
  {
    alert("Debe seleccionar el Area a la que ingresará.");
    return false;
  }
  return true;
}

function validarut_area()
{
  area0=document.form1.AREA[0].checked;
  area1=document.form1.AREA[1].checked;
  rut=document.form1.RUT_EMP.value;
  dv=document.form1.DV_EMP.value;
  if(ValRutDv(rut,dv)==false)
  {
    return false;
  }
  if(!area0 && !area1)
  {
    alert("Debe seleccionar el área a la que ingresará.");
    return false;
  }
  return true;
}

function validaconfirma()
{
  folio=document.form1.FOLIO_INICIAL.value;
  if(esBlanco(folio)==true || esNatural(folio) == false)
  {
    alert("Debe ingresar el Folio Inicial (numérico) para la\nnumeración del documento que está solicitando por primera vez.");
    return false;
  }
  return true;
}

function validarut()
{
  rut=document.form1.RUT_EMP.value;
  dv=document.form1.DV_EMP.value;

  document.form1.RUT_EMP.focus();
  if(ValRutDv(rut,dv)==false)
  {
    document.form1.RUT_EMP.focus();
    return false;
  }
  return true;
}


function validapag(credito_fiscal)
{
  cant_docto=document.form1.CANT_DOCTOS.value;
  tipo_docto=document.form1.COD_DOCTO.value;
  afecto_iva=document.form1.AFECTO_IVA.value;
  factor=document.form1.FACTOR.value;
  anotacion=document.form1.ANOTACION.value;

  if(validarut()==false)
  {
    return false;
  }
  if( tipo_docto=="-1")
  {
    alert ("Debe ingresar el Documento a Timbrar.");
    return false;
  }

  if( (eval(factor) < 1 && eval(factor) >0 ) ) 
  {
    alert ("Sr. Contribuyente: Usted posee situaciones pendientes con el SII que restringen el timbraje de documentos electr\u00f3nicos, por lo tanto, obtendr\u00e1 una cantidad de folios menor a lo normal. Para solucionar las situaciones pendientes debe acudir a la oficina del SII correspondiente a su jurisdicci\u00f3n");
  }


  if ( afecto_iva=="N" )
  {
     if ( anotacion=="N" ) {
       switch (tipo_docto) {
	 case "33"  :
	 case "43"  :
	 case "46"  :
	 case "39" :
         alert ("No ha sido posible completar su solicitud. Esto debido a que el Contribuyente no posee actividades econ\u00f3micas afectas a IVA informadas al Servicio de Impuestos Internos.");
	     return false;
	     break;

	 }	
     }
 }
 

  // Valida que la cantidad sea mayor a 0
  if (esBlanco(cant_docto)==true)
  {
    alert ("Debe ingresar la Cantidad de Documentos a Timbrar.");
    document.form1.CANT_DOCTOS.focus();
    return false;
  }
  else
  {
    if (esNatural(cant_docto)==false)
    {
      alert("La Cantidad de Documentos a Timbrar debe contener solo n\372meros.");
      document.form1.CANT_DOCTOS.focus();
      return false;
    }
    if(largoSinBlancos(cant_docto,1,10)==false)
    {
      alert("La Cantidad de Documentos a Timbrar no debe contener caracteres blancos.");
      document.form1.CANT_DOCTOS.focus();
      return false;
    }
  }

  if (cant_docto < 1)
  {
    alert("La Cantidad de Documentos a Timbrar debe ser mayor a 0.");
    document.form1.CANT_DOCTOS.focus();
    return false;
  }

  if (cant_docto > 9999999 && (tipo_docto!="39" && tipo_docto!="41"))
  {
    alert("La Cantidad m\u00e1xima permitida para Timbrar este documento es de 9.999.999 folios");
    document.form1.CANT_DOCTOS.focus();
    return false;
  }
  if( eval(credito_fiscal) > 0 )
  {
       max_autorizado=document.form1.MAX_AUTOR.value;
       cantidad_timbrajes=document.form1.CANT_TIMBRAJES.value;

       if( eval(cant_docto) > eval(max_autorizado) )
       {
         alert ("La cantidad de documentos a timbrar debe ser menor o igual al m\u00e1ximo autorizado.");
         return false;
       }
       if( eval(cantidad_timbrajes) > 6 )
       {
         alert ("Sr. Contribuyente usted posee documentos disponibles que no ha utilizado, en los pr\u00f3ximos Timbrajes no se autorizarán los folios");
         return false;
       }

  } else
  {
     if( eval(credito_fiscal) ==  0 ) {
       if( eval(document.form1.CON_AJUSTE.value) > 0 )
         if( eval(cant_docto) > eval(document.form1.CON_AJUSTE.value) )
         {
             alert ("La cantidad de documentos a timbrar debe ser menor al ajuste asignado.");
             return false;
         }
       }
  }


  return true;
}


function eu_enrola_usuario()
{
  rut=document.form1.RUT_USU.value;
  dv=document.form1.DV_USU.value;
  firma=document.form1.FIRMAR.checked;
  consulta=document.form1.CONSULTAR.checked;
  supusu=document.form1.SUP_USU.checked;


  if(ValRutDv(rut,dv)==false)
    return false;

  if (eval(rut) > 49999999)
  {
    alert("El rut debe ser de una persona natural.");
    return false;
  }

  if (!document.form1.OBTENER)
  {
    if (!document.form1.ENVIAR)
    {
      {
        if (firma==false)
        {
          if (consulta==false && supusu==false)
          {
            alert("Debe seleccionar al menos un privilegio para el usuario.");
            return false;
          }
        }
      }
    }
    else
    {
      envia=document.form1.ENVIAR.checked;
      if (firma==false && envia==false && consulta==false)
      {
        alert("Debe seleccionar al menos un privilegio para el usuario.");
        return false;
      }
    }
  }
  else
  {
    obtiene=document.form1.OBTENER.checked;
    envia=document.form1.ENVIAR.checked;
    anula=document.form1.ANULAR.checked;
    if (obtiene==false && anula==false && firma==false && envia==false && consulta==false)
    {
      alert("Debe seleccionar al menos un privilegio para el usuario.");
      return false;
    }
  }

  return true;
}


function ee_enrola_empresa()
{
  tipo_fac=document.form1.TIPO_FAC.value;
  fecha_res=document.form1.FEC_RESOL.value;
  fecha_aut=document.form1.FEC_AUTORIZA.value;
  fecha_rev=document.form1.FEC_REVOC.value;
  resol=document.form1.RESOL.value;
  nom_sw=document.form1.NOM_SW.value;
  entidad=document.form1.ENT_CERT.value;
  mail_dte=document.form1.MAIL_DTE.value;
  mail_sup=document.form1.MAIL_SUP.value;
  mail_sii=document.form1.MAIL_SII.value;
  url=document.form1.URL.value;

  if (!esBlanco(fecha_rev))
  {
    if (!validaStrFecha(fecha_rev,'S'))
    {
      alert ("Ha ingresado la fecha de Desautorización inválida, esta debe ser\nigual o posterior a la fecha de hoy (formato: dd-mm-aaaa).");
      document.form1.FEC_REVOC.focus();
      return false;
    }
  }

  if (esBlanco(tipo_fac))
  {
    alert ("Debe ingresar el Tipo de Facturación.");
    document.form1.TIPO_FAC.focus();
    return false;
  }

  if (esBlanco(fecha_aut))
  {
    alert ("Debe ingresar la Fecha de la Autorización de la empresa para operar en el DTE.");
    document.form1.FEC_AUTORIZA.focus();
    return false;
  }
  else if (!validaStrFecha(fecha_aut,'3'))
  {
    document.form1.FEC_AUTORIZA.focus();
    return false;
  }

  if (esBlanco(fecha_res))
  {
    alert ("Debe ingresar la Fecha de la Resolución.");
    document.form1.FEC_RESOL.focus();
    return false;
  }
  else if (!validaStrFecha(fecha_res,'N'))
  {
    alert ("Ha ingresado la fecha de Resolución inválida, esta debe ser\nanterior o igual a la fecha de hoy (formato: dd-mm-aaaa).");
    document.form1.FEC_RESOL.focus();
    return false;
  }
 
  if (esBlanco(nom_sw))
  {
    alert ("Debe ingresar el nombre del software usado por la empresa.");
    document.form1.NOM_SW.focus();
    return false;
  }


  if (esBlanco(resol))
  {
    alert ("Debe ingresar el Número de la Resolución.");
    document.form1.RESOL.focus();
    return false;
  }

  if (esBlanco(entidad))
  {
    alert ("Debe ingresar la Entidad Certificadora del Software.");
    document.form1.ENT_CERT.focus();
    return false;
  }

  if (esBlanco(mail_sup))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y el Usuario-Administrador.");
    document.form1.MAIL_SUP.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sup))
  {
    alert ("El mail de contacto entre el SII y el Usuario-Administrador es inválido (ej: usuario@empresa.cl).");
    document.form1.MAIL_SUP.focus();
    return false;
  }

  if (esBlanco(mail_sii))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y la empresa.");
    document.form1.MAIL_SII.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sii))
  {
    alert ("El mail de contacto entre el SII y las empresas es inválido (ej: contacto@empresa.cl).");
    document.form1.MAIL_SII.focus();
    return false;
  }


  if (esBlanco(mail_dte))
  {
    alert ("Debe ingresar el Mail de contacto entre las empresas.");
    document.form1.MAIL_DTE.focus();
    return false;
  }
  else  if (!esValidoMail2(mail_dte))
  {
    alert ("El mail de contacto entre las empresas, es inválido (ej: empresas@empresa.cl).");
    document.form1.MAIL_DTE.focus();
    return false;
  }

  if (!esBlanco(url))
  {
    if (!esValidoUrl(url))
    {
      alert ("El URL de la empresa es inválido (www.sii.cl).");
      document.form1.URL.focus();
      return false;
    }
  }

  return true;
}


function ee_mod_empresa()
{
  tipo_fac=document.form1.TIPO_FAC.value;
  fecha_aut=document.form1.FEC_AUTOR.value;
  fecha_res=document.form1.FEC_RESOL.value;
  fecha_rev=document.form1.FEC_REVOC.value;
  resol=document.form1.RESOL.value;
  nom_sw=document.form1.NOM_SW.value;
  entidad=document.form1.ENT_CERT.value;
  mail_dte=document.form1.MAIL_DTE.value;
  mail_sup=document.form1.MAIL_SUP.value;
  mail_sii=document.form1.MAIL_SII.value;
  url=document.form1.URL.value;

  if (!esBlanco(fecha_aut))
  {
    if (!validaStrFecha(fecha_aut,'1'))
    {
      alert ("Ha ingresado la Fecha de Autorizaci\363n inválida. (formato: dd-mm-aaaa).");
      document.form1.FEC_AUTOR.focus();
      return false;
    }
  }
  else
  {
    alert ("Debe ingresar la Fecha de Autorizaci\363n. (formato: dd-mm-aaaa).");
    document.form1.FEC_AUTOR.focus();
    return false;
  }
  if (!esBlanco(fecha_rev))
  {
    if (!validaStrFecha(fecha_rev,'S'))
    {
      alert ("Ha ingresado la fecha de Desautorizaci\363n inválida, esta debe ser\nigual o posterior a la fecha de hoy (formato: dd-mm-aaaa).");
      document.form1.FEC_REVOC.focus();
      return false;
    }
  }

  if (esBlanco(tipo_fac))
  {
    alert ("Debe ingresar el Tipo de Facturaci\363n.");
    document.form1.TIPO_FAC.focus();
    return false;
  }

  if (esBlanco(fecha_res))
  {
    alert ("Debe ingresar la Fecha de la Resoluci\363n.");
    document.form1.FEC_RESOL.focus();
    return false;
  }
  else if (!validaStrFecha(fecha_res,'N'))
  {
    alert ("Ha ingresado la fecha de Resoluci\363n inválida, esta debe ser\nanterior o igual a la fecha de hoy (formato: dd-mm-aaaa).");
    document.form1.FEC_RESOL.focus();
    return false;
  }


  if (esBlanco(resol))
  {
    alert ("Debe ingresar el N\372mero de la Resoluci\363n.");
    document.form1.RESOL.focus();
    return false;
  }

  if (esBlanco(nom_sw))
  {
    alert ("Debe ingresar el nombre del software usado por la empresa.");
    document.form1.NOM_SW.focus();
    return false;
  }

  if (esBlanco(entidad))
  {
    alert ("Debe ingresar la Entidad Certificadora del Software.");
    document.form1.ENT_CERT.focus();
    return false;
  }

  if (esBlanco(mail_sup))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y el Usuario-Administrador.");
    document.form1.MAIL_SUP.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sup))
  {
    alert ("El mail de contacto entre el SII y el Usuario-Administrador es inválido (ej: usuario@empresa.cl).");
    document.form1.MAIL_SUP.focus();
    return false;
  }

  if (esBlanco(mail_sii))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y la empresa.");
    document.form1.MAIL_SII.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sii))
  {
    alert ("El mail de contacto entre el SII y la empresa es inválido (ej: contacto@empresa.cl).");
    document.form1.MAIL_SII.focus();
    return false;
  }

  if (!esBlanco(mail_dte))
  {
    if (!esValidoMail2(mail_dte))
    {
      alert ("El mail de contacto entre las empresas, es inválido (ej: empresas@empresa.cl).");
      document.form1.MAIL_DTE.focus();
      return false;
    }
  }

  if (!esBlanco(url))
  {
    if (!esValidoUrl(url))
    {
      alert ("El URL de la empresa es inválido (www.empresa.cl).");
      document.form1.URL.focus();
      return false;
    }
  }
  return true;
}


function ee_nuevo_docto()
{
  cantidad=document.form1.CANT_DOCTOS.value;
  doc1=document.form1.DOC_1.checked;

  en_blanco=0;
  
  if (doc1==false )
    en_blanco++;
  if (cantidad > 1)
  {
    doc2=document.form1.DOC_2.checked;
    if (doc2==false )
      en_blanco++; 
  }
  if (cantidad > 2)
  {
    doc3=document.form1.DOC_3.checked;
    if (doc3==false )
      en_blanco++; 
  }
  if (cantidad > 3)
  {
    doc4=document.form1.DOC_4.checked;
    if (doc4==false )
      en_blanco++; 
  }
  if (cantidad > 4)
  {
    doc5=document.form1.DOC_5.checked;
    if (doc5==false )
      en_blanco++; 
  }
  if (cantidad > 5)
  {
    doc6=document.form1.DOC_6.checked;
    if (doc6==false )
      en_blanco++; 
  }
  if (cantidad > 6)
  {
    doc7=document.form1.DOC_7.checked;
    if (doc7==false )
      en_blanco++; 
  }
  if (cantidad > 7)
  {
    doc8=document.form1.DOC_8.checked;
    if (doc8==false )
      en_blanco++; 
  }
  if (cantidad > 8)
  {
    doc9=document.form1.DOC_9.checked;
    if (doc9==false )
      en_blanco++; 
  }
  if (cantidad > 9)
  {
    doc10=document.form1.DOC_10.checked;
    if (doc10==false )
      en_blanco++; 
  }
  if (cantidad > 10)
  {
    doc11=document.form1.DOC_11.checked;
    if (doc11==false )
      en_blanco++; 
  }
  if (cantidad > 11)
  {
    doc12=document.form1.DOC_12.checked;
    if (doc12==false )
      en_blanco++; 
  }

  if (en_blanco == cantidad)
  {
    alert ("Para ingresar un nuevo documento,\ndebe seleccionar al menos uno.");
    return false;
  }
  return true;
}


function ee_enrola_usuario()
{
  rut=document.form1.RUT_USU.value;
  dv=document.form1.DV_USU.value;
  supusu=document.form1.SUP_USU.checked;
  obtiene=document.form1.OBTENER.checked;
  anula=document.form1.ANULAR.checked;
  firma=document.form1.FIRMAR.checked;
  envia=document.form1.ENVIAR.checked;
  consulta=document.form1.CONSULTAR.checked;

  if(ValRutDv(rut,dv)==false)
    return false;
  else
  {
    if (eval(rut) > 50000000)
    {
      alert("El rut debe ser de una persona natural.");
      return false;
    }
    else
    {
      if (supusu==false && obtiene==false && anula==false && firma==false && envia==false && consulta==false)
      {
        alert("Debe seleccionar al menos un privilegio para el usuario.");
        return false;
      }
      return true;
    }
  }
}
function valida_eliminacion()
{
    alert ("Se dará inicio a la eliminación de empresas..");
    return true;
}

function valida_anulacion()
{
  // Valida que el rango de folios a anular este entre el rango inicial
  folio_ini  =document.form1.FOLIO_INI.value;
  folio_ini_a=document.form1.FOLIO_INI_A.value;
  folio_fin  =document.form1.FOLIO_FIN.value;
  folio_fin_a=document.form1.FOLIO_FIN_A.value;
  motivo     =document.form1.MOTIVO.value;

  if (esBlanco(folio_ini_a)==true || esBlanco(folio_fin_a)==true)
  {
    alert ("Debe ingresar el valor del folio inicial\ny el final para poder continuar, favor revisar..");
    return false;
  }
  else
  {
    if (esNatural(folio_ini_a)==false || largoSinBlancos(folio_ini_a,1,10)==false)
    {
      alert("El número de folio inicial debe contener\nsolo números, favor revisar.");
      document.form1.FOLIO_INI_A.focus();
      return false;
    }
    if (esNatural(folio_fin_a)==false || largoSinBlancos(folio_fin_a,1,10)==false)
    {
      alert("El número de folio final debe contener\nsolo números, favor revisar.");
      document.form1.FOLIO_FIN_A.focus();
      return false;
    }
  }

  if (eval(folio_ini_a) < eval(folio_ini))
  {
    alert("El folio inicial a anular debe ser mayor o igual al folio\ninicial ("+folio_ini+"), favor revisar.");
    document.form1.FOLIO_INI_A.focus();
    return false;
  }

  if (eval(folio_ini_a) > eval(folio_fin))
  {
    alert("El folio inicial a anular debe ser menor o igual al folio\nfinal ("+folio_fin+"), favor revisar.");
    document.form1.FOLIO_INI_A.focus();
    return false;
  }

  if (eval(folio_fin_a) < eval(folio_ini))
  {
    alert("El folio final a anular debe ser mayor o igual al folio\ninicial ("+folio_ini+"), favor revisar.");
    document.form1.FOLIO_FIN_A.focus();
    return false;
  }
  if (eval(folio_ini_a) > eval(folio_fin_a))
  {
    alert("El folio inicial a anular debe ser menor o igual al folio\nfinal, favor revisar.");
    document.form1.FOLIO_INI_A.focus();
    return false;
  }
  if (eval(folio_fin_a) > eval(folio_fin))
  {
    alert("El folio final a anular debe ser menor o igual al folio\nfinal ("+folio_fin+"), favor revisar.");
    document.form1.FOLIO_FIN_A.focus();
    return false;
  }
  if (esBlanco(motivo)==true)
  {
    alert ("Debe ingresar el motivo de la anulación del o los folios, favor revisar.");
    document.form1.MOTIVO.focus();
    return false;
  }

  return true;
}


function ee_mod_docto()
{
  fecha=document.form1.FECHA_DESAC.value;
  motivo=document.form1.MOTIVO.value;

  if (!esBlanco(fecha))
  {
    if (validaStrFecha(fecha,'S'))
    {
      if (esBlanco(fecha)==false && esBlanco(motivo)==true)
      {
        alert ("Al desautorizar un documento, debe ingresar en Observaciones, el motivo de la desautorización");
        return false;
      }
      else
        return true;
    }
    else
    {
      alert ("Ha ingresado una fecha inválida, esta debe ser\nigual o posterior a la fecha de hoy (formato: dd-mm-aaaa).");
      return false;
    }
  }
/*  if (esBlanco(fecha) && esBlanco(motivo)) */
  if (esBlanco(motivo))
  {
    alert ("Si está desautorizando un documento, debe ingresar la fecha de desautorización y el motivo.\nSi está autorizando un documento previamente desautorizado, debe colocar el motivo.");
    return false;
  }
  return true;
}


function esValidoUrl(url)
{
  if ( url.substring(0,4) != 'www.')
  {
    document.form1.URL.focus();
    return false;
  }
  return true;
}


function esValidoMail(mail)
{
  punto = 'N';
  arroba = 0;
  puntos = 0;
  for (i=1;i<=mail.length;i++)
  {
    if (mail.substr(i,1) == ' ')
      return false;
    else
    {
      if (mail.substr(i,1) == '@')
      {
        arroba++;
        if (mail.substr(i+1,1) == '.' || mail.substr(i+1,1) == '@')
          return false;
      }
      else if (arroba > 0)
        if (mail.substr(i,1) == '.')
          puntos++;
    }
  }
  if (mail.substr(mail.length,1) == '.' || mail.substr(mail.length,1) == '@')
    return false;
  if (arroba == 1 && puntos > 0)
    return true;
  else
    return false;
}

function esValidoMail2(mail)
{
  punto = 'N';
  arroba = 0;
  puntos = 0;
  for (i=1;i<=mail.length;i++)
  {
    if (mail.substr(i,1) == ' ' || mail.substr(i,1) == '!' || mail.substr(i,1) == '"' || mail.substr(i,1) == '#' || mail.substr(i,1) == '$' || mail.substr(i,1) == '%' || mail.substr(i,1) == '&' || mail.substr(i,1) == '/' || mail.substr(i,1) == '(' || mail.substr(i,1) == ')' || mail.substr(i,1) == '=' || mail.substr(i,1) == '?' || mail.substr(i,1) == '¿' || mail.substr(i,1) == '¡' || mail.substr(i,1) == '+' || mail.substr(i,1) == '*' || mail.substr(i,1) == 'ñ' || mail.substr(i,1) == 'á' || mail.substr(i,1) == 'é' || mail.substr(i,1) == 'í' || mail.substr(i,1) == 'ó' || mail.substr(i,1) == 'ú' || mail.substr(i,1) == '|' || mail.substr(i,1) == '<' || mail.substr(i,1) == '>' || mail.substr(i,1) == '[' || mail.substr(i,1) == ']' || mail.substr(i,1) == ';')
      return false;
    else
    {
      if (mail.substr(i,1) == '@')
      {
        arroba++;
        if (mail.substr(i+1,1) == '.' || mail.substr(i+1,1) == '@')
          return false;
      }
      else if (arroba > 0)
        if (mail.substr(i,1) == '.')
          puntos++;
    }
  }
  if (mail.substr(mail.length,1) == '.' || mail.substr(mail.length,1) == '@')
    return false;
  if (arroba == 1 && puntos > 0)
    return true;
  else
    return false;
}

// Validador de fecha para el formato dd-mm-yyyy

function validaStrFecha(fecha,tipo)
{

  if ( !isNumero(fecha.substring(0,2)) )
    return false;
  else if (!isNumero(fecha.substring(3,5)))
    return false;
  else if (!isNumero(fecha.substring(6,10)))
    return false;

  if (fecha.substring(2,3)!= '-' || fecha.substring(5,6)!= '-' )
    return false;

  dia = eval(fecha.substring(0,2));
  mes = eval(fecha.substring(3,5));
  ano = eval(fecha.substring(6,10));

  if ( !validaFecha(dia, mes, ano,tipo) )
    return false;

  return true;
}


function validaFecha(dd, mm, yy,tipo) 
{
  var error  = 0;
  var hoy    = new Date();
  var year   = hoy.getFullYear();
  var day    = hoy.getDate();
  var month  = hoy.getMonth();
  var diames = new Array(31,28,31,30,31,30,31,31,30,31,30,31);


  if(((yy%4 == 0) && (yy%100 !=0) ) || (yy%400 == 0))
    diames[1] = 29;

  if (tipo == 'S')
  {
    /* fecha puede ser igual o mayor a hoy */
    if (yy < year)
      return false;
    else if (yy == year)
    {
      if (mm < month+1)
        return false;
      else if (mm == month+1)
      {
        if (dd < day)
          return false;
      }
    }
  }
  else if (tipo == 'N')
  {
    /* fecha puede ser menor o igual a hoy */
    if (yy > year)
      return false;
    else if (yy == year)
    {
      if (mm > (month+1))
        return false;
      else if (mm == (month+1))
        if (dd > day)
          return false;
    }
  }
  else if (tipo == '1')
  {
    /* valida que sea valida solamente */
    if (dd > diames[mm-1] || dd < 1 || mm > 12 || mm < 1 || yy < 2002)
      return false;
  }
  else if (tipo == '2' || tipo == '3')
  {
    /* si la fecha es < a 23-04-2003 no continua */
    if (tipo == '3') 
    {
      if (yy < 2003)
        error = 1;
      else if (yy == 2003)
      {
        if (mm < 4)
          error = 1;
        else if (mm == 4 && dd < 23)
          error = 1;
      }
      
      if (error == 1)
      {
        alert("La fecha de autorización no puede ser anterior a 23-04-2003,\nfavor revisar.");
        return(false);
      }
    }
    /* si la fecha es < a 2 meses avisa */
    if (mm  == 12)
    {
      mm = 2;
      yy = yy + 1;
      if (dd > diames[mm-1])
        dd = diames[mm-1]
    }
    else if (mm == 11)
    {
      mm = 1;
      yy = yy + 1;
    }
    else
      mm = mm + 2;

    if (yy < year)
    {
      if (tipo == '3')
        alert("Aviso: La fecha de autorización es anterior a 2 meses.");
      else
        return false;
    }
    else if (yy == year)
    {
      if (mm < month+1)
      {
        if (tipo == '3')
          alert("Aviso: La fecha de autorización es anterior a 2 meses.");
        else
          return false;
      }
      else if (mm == month+1)
      {
        if (dd < day)
        {
          if (tipo == '3')
            alert("Aviso: La fecha de autorización es anterior a 2 meses.");
          else
            return false;
        }
      }
    }
  }

  if((mm < 1) || (mm > 12))
    return false;
  else if(diames[mm-1] < dd)
    return false

  return true;
}


function isNumero(str) 
{
  var flag = true;
  var i = 0;
  var nums = new Array(1,1,1,1,1,1,1,1,1,1);

  while (i < str.length && flag)
    flag = (nums[str.charAt(i++)] != null);

  return flag;
}


function pe_confirma()
{
  nom_sw=document.form1.NOM_SW.value;
  mail_sup=document.form1.MAIL_SUP.value;
  mail_sii=document.form1.MAIL_SII.value;
  mail_dte=document.form1.MAIL_DTE.value;
  url=document.form1.URL.value;
  rut=document.form1.RUT_USU.value;
  dv=document.form1.DV_USU.value;
  if(ValRutDv(rut,dv)==false)
  {
    document.form1.RUT_USU.focus();
    return false;
  }

  if (esBlanco(mail_sup))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y el Usuario-Administrador.");
    document.form1.MAIL_SUP.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sup))
  {
    alert ("El mail de contacto entre el SII y el Usuario-Administrador es inválido (ej: usuario@empresa.cl).");
    document.form1.MAIL_SUP.focus();
    return false;
  }

  if (esBlanco(mail_sii))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y la empresa.");
    document.form1.MAIL_SII.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sii))
  {
    alert ("El mail de contacto entre el SII y las empresas es inválido (ej: empresas@empresa.cl).");
    document.form1.MAIL_SII.focus();
    return false;
  }

  if (esBlanco(mail_dte))
  {
    alert ("Debe ingresar el Mail de contacto entre empresas.");
    document.form1.MAIL_DTE.focus();
    return false;
  }
  else if (!esValidoMail2(mail_dte))
  {
    alert ("El mail de contacto entre empresas es inválido (ej: empresas@empresa.cl).");
    document.form1.MAIL_DTE.focus();
    return false;
  }

  if (!esBlanco(url))
  {
    if (!esValidoUrl(url))
    {
      alert ("El URL de la empresa es inválido (www.empresa.cl).");
      document.form1.URL.focus();
      return false;
    }
  }

  if (esBlanco(nom_sw))
  {
    alert ("Debe ingresar el nombre del software usado por la empresa.");
    document.form1.NOM_SW.focus();
    return false;
  }

  return true;
}


function pf_confirma()
{
  mail_sup=document.form1.MAIL_SUP.value;
  mail_sii=document.form1.MAIL_SII.value;

 if (esBlanco(mail_sup))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y el Usuario-Administrador.");
    document.form1.MAIL_SUP.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sup))
  {
    alert ("El mail de contacto entre el SII y el Usuario-Administrador es inv\341lido (ej: usuario@empresa.cl).");
    document.form1.MAIL_SUP.focus();
    return false;
  }

  if (esBlanco(mail_sii))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y la empresa.");
    document.form1.MAIL_SII.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sii))
  {
    alert ("El mail de contacto entre el SII y las empresas es inv\341lido (ej: empresas@empresa.cl).");
    document.form1.MAIL_SII.focus();
    return false;
  }
  return true;
}


function validaenvio()
{
  tot_reg=document.form1.TOTREG.value;
  ok = 'X';
  if (tot_reg >= 1)
  {
    fecenv1=document.form1.FEC_ENV1.value;
    numenv1=document.form1.NUM_ENV1.value;
    if (!esBlanco(numenv1) && (!esNatural(numenv1) || esBlanco(fecenv1)) ||
        !esNatural(numenv1) && !esBlanco(fecenv1))
      ok='N';
    else if (esNatural(numenv1) && !esBlanco(fecenv1))
    {
      if (!ValidaFechaEnv(fecenv1))
      {
        document.form1.FEC_ENV1.focus();
        return false;
      }
      ok='S';
    }
  }
  if (tot_reg > 1 && ok!='N')
  {
    numenv2=document.form1.NUM_ENV2.value;
    fecenv2=document.form1.FEC_ENV2.value;
    if (!esBlanco(numenv2) && (!esNatural(numenv2) || esBlanco(fecenv2)) ||
        !esNatural(numenv2) && !esBlanco(fecenv2))
      ok='N';
    else if (esNatural(numenv2) && !esBlanco(fecenv2))
    {
      if (!ValidaFechaEnv(fecenv2))
      {
        document.form1.FEC_ENV2.focus();
        return false;
      }
      ok='S';
    }
  }
  if (tot_reg > 2 && ok!='N')
  {
    numenv3=document.form1.NUM_ENV3.value;
    fecenv3=document.form1.FEC_ENV3.value;
    if (!esBlanco(numenv3) && (!esNatural(numenv3) || esBlanco(fecenv3)) ||
        !esNatural(numenv3) && !esBlanco(fecenv3))
      ok='N';
    else if (esNatural(numenv3) && !esBlanco(fecenv3))
    {
      if (!ValidaFechaEnv(fecenv3))
      {
        document.form1.FEC_ENV3.focus();
        return false;
      }
      ok='S';
    }
  }
  if (tot_reg > 3 && ok!='N')
  {
    numenv4=document.form1.NUM_ENV4.value;
    fecenv4=document.form1.FEC_ENV4.value;
    if (!esBlanco(numenv4) && (!esNatural(numenv4) || esBlanco(fecenv4)) ||
        !esNatural(numenv4) && !esBlanco(fecenv4))
      ok='N';
    else if (esNatural(numenv4) && !esBlanco(fecenv4))
    {
      if (!ValidaFechaEnv(fecenv4))
      {
        document.form1.FEC_ENV4.focus();
        return false;
      }
      ok='S';
    }
  }
  if (tot_reg > 4 && ok!='N')
  {
    numenv5=document.form1.NUM_ENV5.value;
    fecenv5=document.form1.FEC_ENV5.value;
    if (!esBlanco(numenv5) && (!esNatural(numenv5) || esBlanco(fecenv5)) ||
        !esNatural(numenv5) && !esBlanco(fecenv5))
      ok='N';
    else if (esNatural(numenv5) && !esBlanco(fecenv5))
    {
      if (!ValidaFechaEnv(fecenv5))
      {
        document.form1.FEC_ENV5.focus();
        return false;
      } 
      ok='S';
    }
  }
  if (tot_reg > 5 && ok!='N')
  {
    numenv6=document.form1.NUM_ENV6.value;
    fecenv6=document.form1.FEC_ENV6.value;
    if (!esBlanco(numenv6) && (!esNatural(numenv6) || esBlanco(fecenv6)) ||
        !esNatural(numenv6) && !esBlanco(fecenv6))
      ok='N';
    else if (esNatural(numenv6) && !esBlanco(fecenv6))
    {
      if (!ValidaFechaEnv(fecenv6))
      {
        document.form1.FEC_ENV6.focus();
        return false;
      }
      ok='S';
    }
  }
  if (tot_reg > 6 && ok!='N')
  {
    numenv7=document.form1.NUM_ENV7.value;
    fecenv7=document.form1.FEC_ENV7.value;
    if (!esBlanco(numenv7) && (!esNatural(numenv7) || esBlanco(fecenv7)) ||
        !esNatural(numenv7) && !esBlanco(fecenv7))
      ok='N';
    else if (esNatural(numenv7) && !esBlanco(fecenv7))
    {
      if (!ValidaFechaEnv(fecenv7))
      {
        document.form1.FEC_ENV7.focus();
        return false;
      } 
      ok='S';
    }
  }
  if (tot_reg > 7 && ok!='N')
  {
    numenv8=document.form1.NUM_ENV8.value;
    fecenv8=document.form1.FEC_ENV8.value;
    if (!esBlanco(numenv8) && (!esNatural(numenv8) || esBlanco(fecenv8)) ||
        !esNatural(numenv8) && !esBlanco(fecenv8))
      ok='N';
    else if (esNatural(numenv8) && !esBlanco(fecenv8))
    {
      if (!ValidaFechaEnv(fecenv8))
      {
        document.form1.FEC_ENV8.focus();
        return false;
      } 
      ok='S';
    }
  }
  if (tot_reg > 8 && ok!='N')
  {
    numenv9=document.form1.NUM_ENV9.value;
    fecenv9=document.form1.FEC_ENV9.value;
    if (!esBlanco(numenv9) && (!esNatural(numenv9) || esBlanco(fecenv9)) ||
        !esNatural(numenv9) && !esBlanco(fecenv9))
      ok='N';
    else if (esNatural(numenv9) && !esBlanco(fecenv9))
    {
      if (!ValidaFechaEnv(fecenv9))
      {
        document.form1.FEC_ENV9.focus();
        return false;
      } 
      ok='S';
    }
  }
  if (tot_reg > 9 && ok!='N')
  {
    numenv10=document.form1.NUM_ENV10.value;
    fecenv10=document.form1.FEC_ENV10.value;
    if (!esBlanco(numenv10) && (!esNatural(numenv10) || esBlanco(fecenv10)) ||
        !esNatural(numenv10) && !esBlanco(fecenv10))
      ok='N';
    else if (esNatural(numenv10) && !esBlanco(fecenv10))
    {
      if (!ValidaFechaEnv(fecenv10))
      {
        document.form1.FEC_ENV10.focus();
        return false;
      } 
      ok='S';
    }
  }
  if (ok != 'S')
  {
    alert ("Debe ingresar solo Números en N° de Envío y la Fecha en que se efectuó el envió del set.");
    document.form1.FEC_ENV1.focus();
    return false;
  }
  else
    return true;
}


// Validador de fecha para el formato dd-mm-yyyy de envio

function ValidaFechaEnv(fecha)
{
  if ( !isNumero(fecha.substring(0,2)) )
    return false;
  else if (!isNumero(fecha.substring(3,5)))
    return false;
  else if (!isNumero(fecha.substring(6,10)))
    return false;

  if (fecha.substring(2,3)!= '-' || fecha.substring(5,6)!= '-' )
  {
    alert("El formato de la fecha de envío es dd-mm-aaaa");
    return false;
  }

  dia = eval(fecha.substring(0,2));
  mes = eval(fecha.substring(3,5));
  ano = eval(fecha.substring(6,10));

  if ( !FechaEnv(dia, mes, ano) )
    return false;

  return true;
}

function FechaEnv(dd, mm, yy) 
{
  var hoy    = new Date();
  var year   = hoy.getFullYear();
  var day    = hoy.getDate();
  var month  = hoy.getMonth();
  var diames = new Array(31,28,31,30,31,30,31,31,30,31,30,31);

  if ((mm < 1) || (mm > 12))
  {
    alert("La fecha es inválida, vuelva a ingresarla.");
    return false;
  }

  if (((yy%4 == 0) && (yy%100 !=0) ) || (yy%400 == 0))
    diames[1] = 29;

  if (yy+1 < year)
  {
    alert("La fecha de envío no puede ser anterior a\n60 días de la fecha actual.");
    return false;
  }
  else if (yy < year)
  {
    if ((mm == 11 && (month+1) > 1) || (mm == 12 && (month+1) > 2) || 
        (mm < 11))
    {
      alert("La fecha de envío no puede ser anterior a\n60 días de la fecha actual.");
      return false;
    }
    else
    {
      if ((mm == 11 && (month+1) == 1 || mm == 12 && month == 2) && dd < day)
      {
        alert("La fecha de envío no puede ser anterior a\n60 días de la fecha actual.");
        return false;
      }
    }
  }
  else if (yy > year)
  {
    alert("La fecha de envío no puede ser posterior a la fecha actual.");
    return false;
  }
  else if (yy == year)
  {
    if (mm > month+1)
    {
      alert("La fecha de envío no puede ser posterior a la fecha actual.");
      return false;
    }
    else if (mm == month+1)
    {
      if (dd > day)
      {
        alert("La fecha de envío no puede ser posterior a la fecha actual.");
        return false;
      }
    }
    else if ((mm+2) < (month+1))
    {
      alert("La fecha de envío no puede ser anterior a\n60 días de la fecha actual.");
      return false;
    }
    else if ((mm+1) < (month+1))
    {
      if (dd < day)
      {
        alert("La fecha de envío no puede ser anterior a\n60 días de la fecha actual.");
        return false;
      }
    }
  }
  return true;
}


function validaupld()
{
  rut=document.form1.RUT_EMP.value;
  dv=document.form1.DV_EMP.value;
  docto=document.form1.ArchivoUp.value;

  var largo = docto.length;
  if ( largo < 4 )
  {
    alert ("Debe seleccionar un archivo v\341lido que contenga el logo de la empresa.");
    return false;
  }
  else
  {
/* se saca la validacion de espacios en la url del archivo
    for (var i=0;i<largo;i++)
    {
      if(docto.charAt(i) == ' ')
      {
        alert ("El nombre del archivo a enviar, no debe contener espacios entremedio.");
        return false;
      }
    }
*/
    if(docto.charAt(1) != ':' || docto.charAt(2) != '\\')
    {
      alert ("La ruta del archivo no corresponde, verifique y vuelva a intentar.");
      return false;
    }
  }

  if(ValRutDv(rut,dv)==false)
  {
    document.form1.RUT_EMP.focus();
    return false;
  }
  return true;
}


function ee_revisa_ver_emp()
{
  rut=document.form2.RUT_EMP.value;
  dv=document.form2.DV_EMP.value;

  if(ValRutDv(rut,dv)==false)
  {
    document.form2.RUT_EMP.focus();
    return false;
  }
  else
  {
    document.form1.RUT_EMP.value = document.form2.RUT_EMP.value;
    document.form1.DV_EMP.value = document.form2.DV_EMP.value;
    document.form1.action="/cvc_cgi/dte/ee_empresa_rut";
  }
  return true;
}


function ee_revisa_ver_emp_old()
{
  rut=document.form1.RUT_EMP.value;
  dv=document.form1.DV_EMP.value;

  if(ValRutDv(rut,dv)==false)
  {
    document.form1.RUT_EMP.focus();
    return false;
  }
  else
    document.form1.action="/cvc_cgi/dte/ee_empresa_rut";
  return true;
}


function ad_mod_empresa()
{
  tipo_fac=document.form1.TIPO_FAC.value;
  fecha_res=document.form1.FEC_RESOL.value;
  resol=document.form1.RESOL.value;
  nom_sw=document.form1.NOM_SW.value;
  mail_dte=document.form1.MAIL_DTE.value;
  mail_sup=document.form1.MAIL_SUP.value;
  mail_sii=document.form1.MAIL_SII.value;
  url=document.form1.URL.value;

  if (esBlanco(fecha_res))
  {
    alert ("Debe ingresar la Fecha de la Resoluci\363n.");
    document.form1.FEC_RESOL.focus();
    return false;
  }
  else if (!validaStrFecha(fecha_res,'N'))
  {
    alert ("Ha ingresado la fecha de Resoluci\363n inválida, esta debe ser\nanterior o igual a la fecha de hoy (formato: dd-mm-aaaa).");
    document.form1.FEC_RESOL.focus();
    return false;
  }

  if (esBlanco(resol))
  {
    alert ("Debe ingresar el N\372mero de la Resoluci\363n.");
    document.form1.RESOL.focus();
    return false;
  }

  if (esBlanco(nom_sw))
  {
    alert ("Debe ingresar el nombre del software usado por la empresa.");
    document.form1.NOM_SW.focus();
    return false;
  }

  if (esBlanco(mail_sup))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII \ny el Usuario-Administrador.");
    document.form1.MAIL_SUP.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sup))
  {
    alert ("El mail de contacto entre el SII y el Usuario-Administrador \nes inválido (ingrese solo un mail, ej: usuario@empresa.cl).");
    document.form1.MAIL_SUP.focus();
    return false;
  }

  if (esBlanco(mail_sii))
  {
    alert ("Debe ingresar el Mail de contacto entre el SII y la empresa.");
    document.form1.MAIL_SII.focus();
    return false;
  }
  else if (!esValidoMail2(mail_sii))
  {
    alert ("El mail de contacto entre el SII y la empresa es \ninválido (ingrese solo un mail, ej: contacto@empresa.cl).");
    document.form1.MAIL_SII.focus();
    return false;
  }


  if (esBlanco(mail_dte))
  {
    alert ("Debe ingresar el Mail de contacto entre las empresas.");
    document.form1.MAIL_DTE.focus();
    return false;
  }
  else if (!esValidoMail2(mail_dte))
  {
    alert ("El mail de contacto entre las empresas, es inválido \n(ingrese solo un mail, ej: empresas@empresa.cl).");
    document.form1.MAIL_DTE.focus();
    return false;
  }

  if (!esBlanco(url))
  {
    if (!esValidoUrl(url))
    {
      alert ("El URL de la empresa es inválido (www.sii.cl).");
      document.form1.URL.focus();
      return false;
    }
  }

  return true;
}


function validadeclaracion()
{
  opc1=document.form1.OPC1.checked;
  opc2=document.form1.OPC2.checked;
  opc3=document.form1.OPC3.checked;
  opc4=document.form1.OPC4.checked;
  opc5=document.form1.OPC5.checked;
  opc6=document.form1.OPC6.checked;
  opc7=document.form1.OPC7.checked;
  opc8=document.form1.OPC8.checked;

  if (opc1 == false || opc2 == false || opc3 == false || opc4 == false ||
      opc5 == false || opc6 == false || opc7 == false || opc8 == false )
  {
    alert("Debe seleccionar todas las funciones para poder completar \nsu declaración de cumplimiento y así quedar autorizado \nen el sistema.");
      return false;
  }
  else
    return true;
}


function validadeclaracion2()
{
  cont="N";
  if (document.form1.OPC1)
    if (document.form1.OPC1.checked == true)
      cont="S";
  if (document.form1.OPC2)
    if (document.form1.OPC2.checked == true)
      cont="S";
  if (document.form1.OPC3)
    if (document.form1.OPC3.checked == true)
      cont="S";
  if (document.form1.OPC4)
    if (document.form1.OPC4.checked == true)
      cont="S";
  if (document.form1.OPC5)
    if (document.form1.OPC5.checked == true)
      cont="S";
  if (document.form1.OPC6)
    if (document.form1.OPC6.checked == true)
      cont="S";
  if (document.form1.OPC7)
    if (document.form1.OPC7.checked == true)
      cont="S";

  if (cont == "N" )
  {
    alert("Debe seleccionar al menos un documento a autorizar,\nde lo contrario, no podrá efectuar esta operación.");
      return false;
  }
  else
    return true;
}


function validareobtencion()
{
  cont="N";

  if (document.form1.AUTORIZADA.value == "S")
  {
    if (document.form1.SET01)
      if (document.form1.SET01.checked == true)
        cont="S";
  }
  else
    cont="S";
  if (document.form1.SET02)
    if (document.form1.SET02.checked == true)
      cont="S";
  if (document.form1.SET03)
    if (document.form1.SET03.checked == true)
      cont="S";
  if (document.form1.SET04)
    if (document.form1.SET04.checked == true)
      cont="S";
  if (document.form1.SET05)
    if (document.form1.SET05.checked == true)
      cont="S";
  if (document.form1.SET06)
    if (document.form1.SET06.checked == true)
      cont="S";
  if (document.form1.SET07)
    if (document.form1.SET07.checked == true)
      cont="S";
  if (document.form1.SET08)
    if (document.form1.SET08.checked == true)
      cont="S";
  if (document.form1.SET09)
    if (document.form1.SET09.checked == true)
      cont="S";
  if (document.form1.SET10)
    if (document.form1.SET10.checked == true)
      cont="S";
  if (document.form1.SET11)
    if (document.form1.SET11.checked == true)
      cont="S";
  if (document.form1.SET12)
    if (document.form1.SET12.checked == true)
      cont="S";
  if (document.form1.SET15)
    if (document.form1.SET15.checked == true)
      cont="S";
  if (document.form1.SET84)
    if (document.form1.SET84.checked == true)
      cont="S";
  if (document.form1.SET72)
    if (document.form1.SET72.checked == true)
      cont="S";

  if (cont == "N" )
  {
    alert("Debe seleccionar al menos un set a regenerar,\nde lo contrario, no podrá efectuar esta operación.");
      return false;
  }
  else
    return true;
}


function validacambioestado()
{
  tot_reg=document.form1.TOTREG.value;
  ok = 'X';
  if (tot_reg >= 1)
  {
    new_estado=document.form1.NEW_ESTADO1.value;
    old_estado=document.form1.EST1.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 1 )
  {
    new_estado=document.form1.NEW_ESTADO2.value;
    old_estado=document.form1.EST2.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 2 )
  {
    new_estado=document.form1.NEW_ESTADO3.value;
    old_estado=document.form1.EST3.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 3 )
  {
    new_estado=document.form1.NEW_ESTADO4.value;
    old_estado=document.form1.EST4.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 4 )
  {
    new_estado=document.form1.NEW_ESTADO5.value;
    old_estado=document.form1.EST5.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 5 )
  {
    new_estado=document.form1.NEW_ESTADO6.value;
    old_estado=document.form1.EST6.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 6 )
  {
    new_estado=document.form1.NEW_ESTADO7.value;
    old_estado=document.form1.EST7.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 7 )
  {
    new_estado=document.form1.NEW_ESTADO8.value;
    old_estado=document.form1.EST8.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 8 )
  {
    new_estado=document.form1.NEW_ESTADO9.value;
    old_estado=document.form1.EST9.value;
    if (new_estado != old_estado)
      return true;
  }
  if (tot_reg > 9 )
  {
    new_estado=document.form1.NEW_ESTADO10.value;
    old_estado=document.form1.EST10.value;
    if (new_estado != old_estado)
      return true;
  }
  alert("No ha efectuado cambios en el estado de los set.");
  return false;
}


function validafecha_aut()
{
  cant_doc=document.form1.CANT_DOC.value;
  fecha_1=document.form1.FEC_1.value;
  doc_1=document.form1.DOC_1.value;
  var aviso = 0;

  en_blanco=0;
  if (esBlanco(fecha_1))
    en_blanco++;
  else if (!validaStrFecha(fecha_1,'3'))
  {
    aviso = 1;
    document.form1.FEC_1.focus();
    return false;
  }

  if (cant_doc > 1 && aviso == 0)
  {
    fecha_2=document.form1.FEC_2.value;
    doc_2=document.form1.DOC_2.value;

    if (esBlanco(fecha_2))
      en_blanco++;
    else if (!validaStrFecha(fecha_2,'3'))
    {
      aviso = 1;
      document.form1.FEC_2.focus();
      return false;
    }
  }

  if (cant_doc > 2 && aviso == 0)
  {
    fecha_3=document.form1.FEC_3.value;
    doc_3=document.form1.DOC_3.value;

    if (esBlanco(fecha_3))
      en_blanco++;
    else if (!validaStrFecha(fecha_3,'3'))
    {
      aviso = 1;
      document.form1.FEC_3.focus();
      return false;
    }
  }

  if (cant_doc > 3 && aviso == 0)
  {
    fecha_4=document.form1.FEC_4.value;
    doc_4=document.form1.DOC_4.value;

    if (esBlanco(fecha_4))
      en_blanco++;
    else if (!validaStrFecha(fecha_4,'3'))
    {
      aviso = 1;
      document.form1.FEC_4.focus();
      return false;
    }
  }

  if (cant_doc > 4 && aviso == 0)
  {
    fecha_5=document.form1.FEC_5.value;
    doc_5=document.form1.DOC_5.value;

    if (esBlanco(fecha_5))
      en_blanco++;
    else if (!validaStrFecha(fecha_5,'3'))
    {
      aviso = 1;
      document.form1.FEC_5.focus();
      return false;
    }
  }

  if (cant_doc > 5 && aviso == 0)
  {
    fecha_6=document.form1.FEC_6.value;
    doc_6=document.form1.DOC_6.value;

    if (esBlanco(fecha_6))
      en_blanco++;
    else if (!validaStrFecha(fecha_6,'3'))
    {
      document.form1.FEC_6.focus();
      aviso = 1;
      return false;
    }
  }

  if (cant_doc > 6 && aviso == 0)
  {
    fecha_7=document.form1.FEC_7.value;
    doc_7=document.form1.DOC_7.value;

    if (esBlanco(fecha_7))
      en_blanco++;
    else if (!validaStrFecha(fecha_7,'3'))
    {
      document.form1.FEC_7.focus();
      aviso = 1;
      return false;
    }
  }

  if (cant_doc > 7 && aviso == 0)
  {
    fecha_8=document.form1.FEC_8.value;
    doc_8=document.form1.DOC_8.value;

    if (esBlanco(fecha_8))
      en_blanco++;
    else if (!validaStrFecha(fecha_8,'3'))
    {
      aviso = 1;
      document.form1.FEC_8.focus();
      return false;
    }
  }

  if (cant_doc > 8 && aviso == 0)
  {
    fecha_9=document.form1.FEC_9.value;
    doc_9=document.form1.DOC_9.value;

    if (esBlanco(fecha_9))
      en_blanco++;
    else if (!validaStrFecha(fecha_9,'3'))
    {
      document.form1.FEC_9.focus();
      aviso = 1;
      return false;
    }
  }

  if (cant_doc > 9 && aviso == 0)
  {
    fecha_10=document.form1.FEC_10.value;
    doc_10=document.form1.DOC_10.value;

    if (esBlanco(fecha_10))
      en_blanco++;
    else if (!validaStrFecha(fecha_10,'3'))
    {
      document.form1.FEC_10.focus();
      aviso = 1;
      return false;
    }
  }

  if (cant_doc > 10 && aviso == 0)
  {
    fecha_11=document.form1.FEC_11.value;
    doc_11=document.form1.DOC_11.value;

    if (esBlanco(fecha_11))
      en_blanco++;
    else if (!validaStrFecha(fecha_11,'3'))
    {
      aviso = 1;
      document.form1.FEC_11.focus();
      return false;
    }
  }

  if (cant_doc > 11 && aviso == 0)
  {
    fecha_12=document.form1.FEC_12.value;
    doc_12=document.form1.DOC_12.value;

    if (esBlanco(fecha_12))
      en_blanco++;
    else if (!validaStrFecha(fecha_12,'3'))
    {
      aviso = 1;
      document.form1.FEC_12.focus();
      return false;
    }
  }

  if (cant_doc > 12 && aviso == 0)
  {
    fecha_13=document.form1.FEC_13.value;
    doc_13=document.form1.DOC_13.value;

    if (esBlanco(fecha_13))
      en_blanco++;
    else if (!validaStrFecha(fecha_13,'3'))
    {
      aviso = 1;
      document.form1.FEC_13.focus();
      return false;
    }
  }

  if (cant_doc > 13 && aviso == 0)
  {
    fecha_14=document.form1.FEC_14.value;
    doc_14=document.form1.DOC_14.value;

    if (esBlanco(fecha_14))
      en_blanco++;
    else if (!validaStrFecha(fecha_14,'3'))
    {
      aviso = 1;
      document.form1.FEC_14.focus();
      return false;
    }
  }

  if (cant_doc > 14 && aviso == 0)
  {
    fecha_15=document.form1.FEC_15.value;
    doc_15=document.form1.DOC_15.value;

    if (esBlanco(fecha_15))
      en_blanco++;
    else if (!validaStrFecha(fecha_15,'3'))
    {
      aviso = 1;
      document.form1.FEC_15.focus();
      return false;
    }
  }

  if (en_blanco > 0)
  {
    alert ("Debe ingresar la fecha de vigencia para todos los documentos, esta puede ser\nhasta 2 meses antes de la fecha actual o posterior a esta (formato: dd-mm-aaaa).");
    document.form1.FEC_1.focus();
    return false;
  }
}


function cambia_href_pf()
{
  var url = "Portal001/menuFacturaElectronica.html";

  if (location.host == "edmd.sii.cl" )
    ref='https://mipyme.sii.cl/'+url;
  else
    ref='https://'+location.host+'/'+url;

  document.writeln("<a href="+ref+">");
} /* Fin cambia_href_pf */  


function cambia_href_pe(opcion)
{
  var url = "";

  if ( opcion == 1 )
    url="cvc/dte/postulacion.html";
  if ( opcion == 2 )
    url="cvc/dte/pe_condiciones.html";
  if ( opcion == 3 )
    url="cvc_cgi/dte/ce_documentos";
  if ( opcion == 4 )
    url="cvc_cgi/dte/pe_avance1";
  if ( opcion == 5 )
    url="cvc_cgi/dte/pe_avance5";
  if ( opcion == 6 )
    url="cvc_cgi/dte/pe_avance7";
  if ( opcion == 7 )
    url="cvc_cgi/dte/pe_generar";
  if ( opcion == 8 )
    url="cvc_cgi/dte/pe_construccion_dte";
  if ( opcion == 9 )
  {
    if (location.host == "edmd.sii.cl" || location.host == "maullin.sii.cl" )
      ref='https://'+location.host+'/cvc/dte/menu.html';
    else
      ref='https://maullin.sii.cl/cvc/dte/certificacion_dte.html';
  }
  else
  {
    if ( opcion == 9 )
    {
      url="Portal001/menuFacturaElectronica.html";
      if (location.host == "edmd.sii.cl" )
        ref='https://mipyme.sii.cl/'+url;
      else if (location.host == "maullin.sii.cl" )
        ref='https://mipyme-p.sii.cl/'+url;
      else
        ref='https://www1.sii.cl/'+url;
    }
    else
    {
      if (location.host == "edmd.sii.cl" )
        ref='https://'+location.host+'/'+url;
      else
        ref='https://maullin.sii.cl/'+url;
    }
  }

  document.writeln("<a href="+ref+">");
} /* Fin cambia_href_pe */  


function ver_doctos(rut)
{
  location.href='/cvc_cgi/dte/ee_autoriza_ptl2?'+rut;
} /* Fin ver_doctos */  


function ivalidaAutMasiva()
{
  opc1=document.form1.OPC1.checked;
  opc2=document.form1.OPC2.checked;
  opc3=document.form1.OPC3.checked;
  opc4=document.form1.OPC4.checked;
  opc5=document.form1.OPC5.checked;
  opc6=document.form1.OPC6.checked;
  opc7=document.form1.OPC7.checked;

  if (opc1 == false || opc2 == false || opc3 == false || opc4 == false ||
      opc5 == false || opc6 == false || opc7 == false )
  {
    alert("Debe seleccionar todas las funciones para poder efectuar\nla declaración, de lo contrario, no podrá efectuarla.");
      return false;
  }
  else
    return true;
}


function validaAutMasiva()
{
  tot_reg=document.frm1.TOTEMP.value;
  fecaut=document.frm1.FECHA_AUT.value;
  fecaut_d=document.frm1.FECHA_AUT_D.value;
  fecres=document.frm1.FECHA_RES.value;
  numres=document.frm1.NUM_RES.value;
  ok = 0;
  i=1;
  
  if (esBlanco(fecaut))
  {
    alert ("Debe ingresar la Fecha de la Autorización de la empresa para operar en el DTE.");
    document.frm1.FECHA_AUT.focus();
    return false;
  }
  else if (!validaStrFecha(fecaut,'2'))
  {
    alert ("Ha ingresado la fecha de Autorización de la Empresa inválida, esta puede ser\nhasta 2 meses antes de la fecha actual o posterior a ésta (formato: dd-mm-aaaa).");
    document.frm1.FECHA_AUT.focus();
    return false;
  }
  
  if (esBlanco(fecaut_d))
  {
    alert ("Debe ingresar la Fecha de la Autorización de los Documentos para operar en el DTE.");
    document.frm1.FECHA_AUT_D.focus();
    return false;
  }
  else if (!validaStrFecha(fecaut_d,'2'))
  {
    alert ("Ha ingresado la fecha de Autorización de los Documentos inválida, esta puede ser\nhasta 2 meses antes de la fecha actual o posterior a ésta (formato: dd-mm-aaaa).");
    document.frm1.FECHA_AUT_D.focus();
    return false;
  }

  if (esBlanco(fecres))
  {
    alert ("Debe ingresar la Fecha de la Resolución.");
    document.frm1.FECHA_RES.focus();
    return false;
  }
  else if (!validaStrFecha(fecres,'N'))
  {
    alert ("Ha ingresado la fecha de Resolución inválida, esta debe ser\nanterior o igual a la fecha de hoy (formato: dd-mm-aaaa).");
    document.frm1.FECHA_RES.focus();
    return false;
  }
 
  if (!esNatural(numres))
  {
    alert ("El Número de la Resolución es numérica y obligatoria.");
    document.frm1.NUM_RES.focus();
    return false;
  }
   

  /* Revisa si existe al menos 1 box seleccionados */
  while (i <= tot_reg)
  {
    celda=document.getElementById("AUT"+i);
    if (celda.checked)
      ok=1;
    i++;
  }
  if (ok == 0)
  {
    alert ("Debe seleccionar al menos una empresa para poder continuar.");
    return false;
  }
} /* fin validaAutMasiva */


function validaDocto888y889(idCampo,docto)
{
  i = 1;

  if (idCampo.checked == true)
  {
    while (i <= eval(document.form1.CANT_DOCTOS.value))
    {
      var celda=document.getElementById("DOC"+i);
      if (celda.checked && (celda.value == 888 || celda.value==889))
        if (celda.value == 888 && idCampo.value == 889 || celda.value == 889 && idCampo.value == 888)
          celda.checked = false;
      i++;
    }
  }
} /* Fin validaDocto888y889 */
